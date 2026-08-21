#!/usr/bin/env node
// convert-cad-server — drag & drop web UI for the standalone CAD -> GLB/GLTF tool.
//
// Serves index.html on http://<host>:<port>/ and exposes POST /convert, which
// accepts a multipart upload (a STEP/IGES/STL 'model' + 'fmt' = glb|gltf),
// runs the same Docker/OpenCascade converter the CLI uses,
// and streams the converted .glb (or .gltf+.bin) back to the browser for download.
//
// Usage:
//   convert-cad-server.mjs [--port 8787] [--host 0.0.0.0] [--backend docker|native]
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync,
         readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { colorsOnlyGlb } from './appearance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONVERTER = join(__dirname, 'convert-cad.py');
const INDEX = join(__dirname, 'index.html');
// Locate the three.js module tree for the 3D preview. It lives in two layouts:
//   - dev (tools/convert-cad/...):  <repo>/node_modules/three   (two dirs up)
//   - portable zip (flat root):     node_modules/three           (next to server)
// Try both; three.js is only needed for the preview, so a miss just 404s.
const THREE_CANDIDATES = [
  join(__dirname, '..', '..', 'node_modules', 'three'),
  join(__dirname, 'node_modules', 'three'),
];
const THREE_ROOT = THREE_CANDIDATES.find(p => existsSync(join(p, 'package.json'))) || THREE_CANDIDATES[0];
// Serve three.js under /three/ : files in build/ (three.module.js, three.core.js) -> build/,
// anything else -> examples/jsm/.
function threeFileFor(urlPath){
  const rel = urlPath.slice('/three/'.length);
  const buildName = basename(rel);
  if (buildName === 'three.module.js' || buildName === 'three.core.js') return join(THREE_ROOT, 'build', buildName);
  return join(THREE_ROOT, 'examples', 'jsm', rel);
}
const SUPPORTED = { '.step':'STEP','.stp':'STEP','.igs':'IGES','.iges':'IGES','.stl':'STL' };
const PASSTHROUGH = { '.glb':'glb', '.gltf':'gltf' };   // already-converted: no Docker needed
const MAX_BODY = 300 * 1024 * 1024; // 300 MB upload cap
const QUALITY_PROFILES = {
  faithful: { deflection: 0.2, angular: 0.5 },
  balanced: { deflection: 0.5, angular: 0.7 },
  large: { deflection: 1.0, angular: 1.0 },
  preview: { deflection: 2.0, angular: 1.5 },
};

let PORT = 8787, HOST = '0.0.0.0', DEFAULT_BACKEND = 'docker', PYTHON_EXEC = process.env.CAD_PYTHON || 'python';
const argv = process.argv.slice(2);
for (let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--port')PORT=Number(argv[++i]);
  else if(a==='--host')HOST=argv[++i];
  else if(a==='--backend')DEFAULT_BACKEND=(argv[++i]||'docker').toLowerCase();
  else if(a==='--python')PYTHON_EXEC=argv[++i];
  else if(a.startsWith('--port='))PORT=Number(a.split('=')[1]);
  else if(a.startsWith('--host='))HOST=a.split('=')[1];
  else if(a.startsWith('--backend='))DEFAULT_BACKEND=a.split('=')[1].toLowerCase();
  else if(a.startsWith('--python='))PYTHON_EXEC=a.split('=')[1];
}
if(!['docker','native'].includes(DEFAULT_BACKEND)) throw new Error(`unknown --backend '${DEFAULT_BACKEND}' (use docker|native)`);

function run(cmd,args,opts={}){
  return new Promise((res,rej)=>{
    execFile(cmd,args,{maxBuffer:16*1024*1024,...opts},(err,so,se)=>{
      if(err&&!opts.allowNonZero)return rej(new Error(String(se||err.message)));
      res({code:err?(err.code??1):0,stdout:String(so||''),stderr:String(se||'')});
    });
  });
}

function die(msg){throw new Error(msg);}

// ---- multipart body parser (minimal, buffer-based) ----
function parseMultipart(buf, boundary){
  const delim = Buffer.from('--'+boundary);
  const parts=[];
  let idx=buf.indexOf(delim);
  while(idx!==-1){
    idx += delim.length;
    if(buf.subarray(idx,idx+2).toString()==='--')break;       // final boundary
    idx += 2;                                                   // skip CRLF
    const headEnd=buf.indexOf('\r\n\r\n',idx);
    if(headEnd===-1)break;
    const header=buf.subarray(idx,headEnd).toString('utf8');
    const bodyStart=headEnd+4;
    const next=buf.indexOf(delim,bodyStart);
    if(next===-1)break;
    const body=buf.subarray(bodyStart,next-2);                 // strip trailing CRLF
    const nameM=/name="([^"]*)"/.exec(header);
    const fileM=/filename="([^"]*)"/.exec(header);
    parts.push({name:nameM?nameM[1]:null, filename:fileM?fileM[1]:null, body});
    idx=next;
  }
  return parts;
}

// Host-side glTF geometry compression (Draco) via the self-contained draco3d
// compressor (draco-compress.mjs). Runs after Docker conversion so the
// container image stays untouched. GLB only.
async function compressGlbBuffer(glbBuf, level = 7) {
  const { compressGlb } = await import('./draco-compress.mjs');
  const r = await compressGlb(glbBuf, { level });
  return { buf: r.buf, ms: r.ms, inBytes: r.inBytes, outBytes: r.outBytes };
}

function field(parts, name, fallback = '') {
  return (parts.find(p => p.name === name) || {}).body?.toString().trim() || fallback;
}

function qualitySettings(parts) {
  const optimize = !['0', 'false', 'off', 'no'].includes(field(parts, 'optimize', '1').toLowerCase());
  const profile = field(parts, 'profile', 'large').toLowerCase();
  const base = QUALITY_PROFILES[profile] || QUALITY_PROFILES.large;
  const number = (name, fallback, low, high) => {
    const n = Number(field(parts, name, String(fallback)));
    return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
  };
  return {
    optimize,
    profile: QUALITY_PROFILES[profile] ? profile : 'custom',
    deflection: optimize ? number('deflection', base.deflection, 0.01, 10) : 0.2,
    angular: optimize ? number('angular', base.angular, 0.05, 5) : 0.5,
    level: Math.round(number('level', 7, 0, 10)),
  };
}

async function handleConvert(req,res){
  const ctype=req.headers['content-type']||'';
  const bm=/boundary=(.+)$/.exec(ctype);
  if(!bm)return sendErr(res,400,'multipart/form-data with boundary required');

  // read body
  const chunks=[]; let total=0;
  for await (const c of req){ total+=c.length; if(total>MAX_BODY)return sendErr(res,413,'upload too large'); chunks.push(c); }
  const buf=Buffer.concat(chunks);
  let parts; try{ parts=parseMultipart(buf,bm[1]); }catch{ return sendErr(res,400,'bad multipart body'); }

  const model=parts.find(p=>p.name==='model'&&p.body.length>0);
  const fmt=field(parts, 'fmt', 'glb').toLowerCase()==='gltf'?'gltf':'glb';
  const compress=field(parts, 'compress', 'none').toLowerCase();
  const backend=field(parts, 'backend', DEFAULT_BACKEND).toLowerCase();
  const appearance=field(parts, 'appearance', 'preserve').toLowerCase();
  const quality=qualitySettings(parts);
  if(!model)return sendErr(res,400,'no model file uploaded');
  if(!['docker','native'].includes(backend))return sendErr(res,400,`unsupported backend '${backend}' (only 'docker' or 'native' is supported)`);
  if(!['preserve','colors'].includes(appearance))return sendErr(res,400,`unsupported appearance '${appearance}' (only 'preserve' or 'colors' is supported)`);

  const ext=extname(model.filename).toLowerCase();
  const isPassthrough = ext in PASSTHROUGH;
  if(!isPassthrough && !(ext in SUPPORTED))
    return sendErr(res,400,`unsupported extension '${ext}' (need .step/.stp/.igs/.iges/.stl/.glb/.gltf)`);

  // Fast path: file is already GLB/GLTF — no Docker. Return it straight for
  // preview/download, optionally Draco-compressing a GLB.
  if (isPassthrough) {
    const stem=basename(model.filename).replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9_.-]/g,'_')||'model';
    const fmt=PASSTHROUGH[ext];
    const dlName=stem+'.'+ext.slice(1);
    let outBuf=model.body;
    const log=[];
    if (appearance === 'colors') {
      if (fmt === 'glb') {
        const before = outBuf.length;
        try { outBuf = colorsOnlyGlb(outBuf); log.push(`appearance colors ${before}->${outBuf.length} bytes`); }
        catch (e) { return sendErr(res, 400, `colors-only appearance failed: ${e.message}`); }
      } else {
        log.push('appearance colors only applies to .glb output; preserving .gltf textures');
      }
    }
    if (fmt==='glb' && compress==='draco') {
      try {
        const comp=await compressGlbBuffer(outBuf, quality.level);
        outBuf=comp.buf;
        log.push('draco '+comp.inBytes+'->'+comp.outBytes+' bytes in '+comp.ms+' ms');
      } catch (e) {
        log.push('draco compression failed, returning uncompressed: '+e.message);
      }
    } else if (fmt==='gltf' && compress!=='none') {
      log.push('draco compression only applies to .glb output; skipping for .gltf');
    }
    log.unshift(`mesh quality: passthrough; profile=${quality.profile} optimize=${quality.optimize ? 'on' : 'off'} dracoLevel=${quality.level}`);
    const headers={
      'Content-Type': fmt==='glb'?'model/gltf-binary':'model/gltf+json',
      'Content-Disposition':`attachment; filename="${dlName}"`,
      'Content-Length':outBuf.length,
      'X-Convert-Log': Buffer.from((log.length?log.join('\n'):'passthrough (no conversion)')).toString('base64'),
      'X-Passthrough':'1',
    };
    res.writeHead(200,headers);
    return res.end(outBuf);
  }

  // STL is a pure mesh: convert HOST-SIDE with the direct JS writer (no Docker).
  // The OCCT/B-rep path emits one glTF primitive per facet -> ~10x blowup (and
  // Draco can't fix structural bloat); stl2glb.mjs writes a single welded
  // primitive, typically smaller than the source STL.
  if (ext === '.stl') {
    const stem = basename(model.filename).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'model';
    const work = mkdtempSync(join(tmpdir(), 'convert-cad-web-'));
    try {
      const inPath = join(work, 'model.stl');
      const outPath = join(work, 'model.glb');
      writeFileSync(inPath, model.body);
      execFileSync(process.execPath, [join(__dirname, 'stl2glb.mjs'), inPath, outPath, '--stem', stem],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let fileBuf = readFileSync(outPath);
      const log = ['STL -> GLB (host-side, no Docker)'];
      if (appearance === 'colors') {
        const before = fileBuf.length;
        fileBuf = colorsOnlyGlb(fileBuf);
        log.push(`appearance colors ${before}->${fileBuf.length} bytes`);
      }
      if (compress === 'draco') {
        try { const comp = await compressGlbBuffer(fileBuf, quality.level); fileBuf = comp.buf; log.push(`draco ${comp.inBytes}->${comp.outBytes} bytes in ${comp.ms} ms`); }
        catch (e) { log.push('draco compression failed, returning uncompressed: ' + e.message); }
      } else if (compress !== 'none') {
        return sendErr(res, 400, `unsupported compress '${compress}' (only 'draco' is supported)`);
      }
      log.unshift(`mesh quality: STL direct writer; profile=${quality.profile} optimize=${quality.optimize ? 'on' : 'off'} dracoLevel=${quality.level}`);
      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Disposition': `attachment; filename="${stem}.glb"`,
        'Content-Length': fileBuf.length,
        'X-Convert-Log': Buffer.from(log.join('\n')).toString('base64'),
      });
      return res.end(fileBuf);
    } catch (e) {
      return sendErr(res, 500, ((e.stderr || '').toString() || 'stl2glb failed').slice(-4000));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Pre-flight only the selected backend. STL and GLB/GLTF passthrough do not
  // need either backend.
  if(backend==='docker'){
    try{ execFileSync('docker',['version','--format','{{.Server.Version}}'],{stdio:'ignore'}); }
    catch{ return sendErr(res,503,'Docker is not running. Start Docker Desktop or run the server with --backend native.'); }
  } else {
    try{ execFileSync(PYTHON_EXEC,['-c','import OCP'],{stdio:'ignore'}); }
    catch{ return sendErr(res,503,`native Python '${PYTHON_EXEC}' cannot import OCP; set CAD_PYTHON or use --python`); }
  }

  const work=mkdtempSync(join(tmpdir(),'convert-cad-web-'));
  try{
    const inName='model'+ext;
    writeFileSync(join(work,inName),model.body);

    const stem=basename(model.filename).replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9_.-]/g,'_')||'model';
    const outName='model.'+fmt;
    const toolHost = __dirname.split('\\').join('/');   // forward slashes for docker -v on Windows
    const workHost = work.split('\\').join('/');        // same for the temp work dir
    const dockerArgs=['run','--rm','--env',`CQ_STEM=${stem}`,
      '--env',`CQ_OPTIMIZE=${quality.optimize ? '1' : '0'}`,
      '--env',`CQ_PROFILE=${quality.profile}`,
      '--env',`CQ_DEFLECTION=${quality.deflection}`,
      '--env',`CQ_ANGULAR=${quality.angular}`,
      '-v',`${workHost}:/w`,'-v',`${toolHost}:/tool:ro`,'-w','/w',
      'chair-cq:local','python','/tool/convert-cad.py',`/w/${inName}`,`/w/${outName}`];
    const nativeArgs=[CONVERTER,join(work,inName),join(work,outName),`--stem=${stem}`];
    const command=backend==='docker'?'docker':PYTHON_EXEC;
    const args=backend==='docker'?dockerArgs:nativeArgs;

    const {code,stdout,stderr}=await run(command,args,{env:backend==='native'?{
      ...process.env,
      CQ_STEM:stem,
      CQ_OPTIMIZE:quality.optimize?'1':'0',
      CQ_PROFILE:quality.profile,
      CQ_DEFLECTION:String(quality.deflection),
      CQ_ANGULAR:String(quality.angular),
    }:undefined});
    const log=[stderr.trim()];
    const outPath=join(work,outName);
    if(code!==0||!existsSync(outPath))return sendErr(res,500,(log.join('\n')||'conversion failed').slice(-4000));

    const fileBuf0=readFileSync(outPath);
    // For .gltf, embed the sibling .bin as a data-URI so the output is self-contained
    // (valid for the preview and for a single-file download). The .glb is already binary.
    let fileBuf=fileBuf0;
    let compNote='';
    if(fmt==='gltf'){
      const binPath=join(work,'model.bin');
      if(existsSync(binPath)){
        const gltf=JSON.parse(fileBuf0.toString('utf8'));
        const b64=readFileSync(binPath).toString('base64');
        if(gltf.buffers&&gltf.buffers[0])gltf.buffers[0].uri='data:application/octet-stream;base64,'+b64;
        fileBuf=Buffer.from(JSON.stringify(gltf));
      }
    } else if (appearance === 'colors') {
      const before = fileBuf.length;
      fileBuf = colorsOnlyGlb(fileBuf);
      log.push(`appearance colors ${before}->${fileBuf.length} bytes`);
      if (compress === 'draco') {
        const comp=await compressGlbBuffer(fileBuf, quality.level);
        fileBuf=comp.buf;
        compNote=`draco ${comp.inBytes}->${comp.outBytes} bytes in ${comp.ms} ms`;
        log.push(compNote);
      } else if (compress !== 'none') {
        return sendErr(res,400,`unsupported compress '${compress}' (only 'draco' is supported)`);
      }
    } else if (compress==='draco') {
      const comp=await compressGlbBuffer(fileBuf0, quality.level);
      fileBuf=comp.buf;
      compNote=`draco ${comp.inBytes}->${comp.outBytes} bytes in ${comp.ms} ms`;
      log.push(compNote);
    } else if (compress!=='none') {
      return sendErr(res,400,`unsupported compress '${compress}' (only 'draco' is supported)`);
    }
    const dlName=stem+'.'+fmt;
    const headers={
      'Content-Type': fmt==='glb'?'model/gltf-binary':'model/gltf+json',
      'Content-Disposition':`attachment; filename="${dlName}"`,
      'Content-Length':fileBuf.length,
      'X-Convert-Log': Buffer.from(log.join('\n')||'').toString('base64'),
    };
    res.writeHead(200,headers);
    res.end(fileBuf);
  }catch(e){
    sendErr(res,500,e.message);
  }finally{
    rmSync(work,{recursive:true,force:true});
  }
}

function sendErr(res,code,msg){
  res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});
  res.end(msg);
}

const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  try{
    if(url.pathname==='/'||url.pathname==='/index.html'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
      res.end(readFileSync(INDEX));
    } else if(url.pathname==='/favicon.ico'){
      res.writeHead(204); res.end();
    } else if(url.pathname.startsWith('/three/')){
      const f=threeFileFor(url.pathname);
      if(!existsSync(f))return sendErr(res,404,'three.js module not found (run npm install in the repo root)');
      const mime = url.pathname.endsWith('.wasm') ? 'application/wasm'
        : url.pathname.endsWith('.js') ? 'text/javascript'
        : url.pathname.endsWith('.json') ? 'application/json'
        : 'application/octet-stream';
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public, max-age=86400'});
      res.end(readFileSync(f));
    } else if(url.pathname==='/convert'&&req.method==='POST'){
      await handleConvert(req,res);
    } else {
      res.writeHead(404,{'Content-Type':'text/plain'}); res.end('not found');
    }
  }catch(e){ try{sendErr(res,500,'server error: '+e.message);}catch{} }
});

server.listen(PORT,HOST,()=>{
  console.log(`convert-cad web UI running at http://localhost:${PORT}`);
  console.log(`  drag & drop a STEP/IGES/STL, pick GLB/GLTF, hit Convert, Download.`);
  console.log(`  default backend: ${DEFAULT_BACKEND}; UI can select Docker or native Python`);
  console.log(`  native Python: ${PYTHON_EXEC}`);
});
