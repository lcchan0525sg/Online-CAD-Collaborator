FROM python:3.11-slim
WORKDIR /w
# OpenCascade (OCP) links against system OpenGL / X libs at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libgl1 libglu1-mesa libxrender1 libxext6 libx11-6 libxcursor1 libxft2 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir cadquery
# gen_cq.py and chair_parts.json are mounted at /w at run time.
