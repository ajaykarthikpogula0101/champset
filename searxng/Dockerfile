# SearXNG image for Railway.
#
# The upstream searxng/searxng image ships with JSON output disabled, but the
# agent web layer (search_web) calls SearXNG with format=json. This bakes the
# repo settings.yml (which enables the json format) into the image so the
# container serves JSON out of the box, with no volume or manual edit needed.
#
# Built from the repo ROOT context (so the COPY path is repo-relative). On
# Railway, set the service variable RAILWAY_DOCKERFILE_PATH=searxng/Dockerfile
# and leave Root Directory at the repo root.
FROM searxng/searxng:latest
COPY searxng/settings.yml /etc/searxng/settings.yml
