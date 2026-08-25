#!/usr/bin/env python3
"""
Playwright screenshot sidecar for DIOSCURI demo pages.

  python scripts/screenshot_server.py
  curl -X POST http://127.0.0.1:8767/v1/screenshots/capture \\
    -H 'content-type: application/json' \\
    -d '{"url":"https://magic-ai-factory.com/monitor/"}' \\
    -o demo.png

Env:
  DIOSCURI_SCREENSHOT_PORT  default 8767
  DIOSCURI_SCREENSHOT_HOST  default 0.0.0.0
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import struct
import sys
import zlib
from typing import Annotated

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, HttpUrl

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("screenshot_server")

app = FastAPI(title="DIOSCURI Screenshot Sidecar", version="1.1")

MIN_PNG_BYTES = 50_000
MAX_BLANK_RATIO = 0.92
MAX_DARK_RATIO = 0.78
MIN_VISIBLE_TEXT = 35


class CaptureRequest(BaseModel):
    url: HttpUrl
    viewport: str = "1280x720"
    wait_ms: Annotated[int, Field(ge=500, le=30_000)] = 6000


def parse_viewport(vp: str) -> tuple[int, int]:
    m = re.match(r"^(\d{2,4})x(\d{2,4})$", (vp or "").strip())
    if not m:
        return 1280, 720
    return int(m.group(1)), int(m.group(2))


async def preflight(url: str) -> None:
    import httpx

    if "**" in url:
        raise HTTPException(status_code=422, detail="demo URL contains invalid characters")
    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
        res = await client.get(url)
        if res.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"demo URL returned HTTP {res.status_code}")
        body = (res.text or "")[:4000].lower()
        for needle in ("502 bad gateway", "application error", "service unavailable", "page not found"):
            if needle in body:
                raise HTTPException(status_code=502, detail=f"demo page looks broken: {needle}")


def extract_idat(png: bytes) -> bytes:
    pos = 8
    parts: list[bytes] = []
    while pos + 12 <= len(png):
        length = struct.unpack(">I", png[pos : pos + 4])[0]
        ctype = png[pos + 4 : pos + 8]
        data = png[pos + 8 : pos + 8 + length]
        if ctype == b"IDAT":
            parts.append(data)
        pos += 12 + length
    return b"".join(parts)


def png_mostly_blank(png: bytes) -> bool:
    """Cheap blank-frame detector — sample compressed IDAT bytes."""
    if len(png) < MIN_PNG_BYTES or png[:8] != b"\x89PNG\r\n\x1a\n":
        return True
    idat = extract_idat(png)
    if not idat:
        return True
    step = max(400, len(idat) // 200)
    samples = [idat[i] for i in range(0, min(len(idat), 200_000), step)]
    if not samples:
        return True
    mean = sum(samples) / len(samples)
    close = sum(1 for v in samples if abs(v - mean) < 8)
    return close / len(samples) >= MAX_BLANK_RATIO


def png_mostly_dark(png: bytes) -> bool:
    """Reject overwhelmingly dark frames (empty SPA shells, failed renders)."""
    idat = extract_idat(png)
    if len(idat) < 500:
        return True
    step = max(200, len(idat) // 300)
    dark = 0
    total = 0
    for i in range(0, len(idat), step):
        total += 1
        if idat[i] < 28:
            dark += 1
        if total >= 300:
            break
    return total > 0 and dark / total >= MAX_DARK_RATIO


def validate_png(png: bytes) -> None:
    if len(png) < MIN_PNG_BYTES:
        raise HTTPException(status_code=422, detail=f"screenshot too small ({len(png)} bytes)")
    if png_mostly_blank(png):
        raise HTTPException(status_code=422, detail="screenshot looks blank or uniform")
    if png_mostly_dark(png):
        raise HTTPException(status_code=422, detail="screenshot mostly dark (empty or loading shell)")


async def page_has_visible_content(page) -> None:
    stats = await page.evaluate(
        """() => {
          const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
          const rich = document.querySelectorAll(
            'canvas, svg path, img[src]:not([src^="data:"]), video, iframe, main, [role=main]'
          ).length;
          return { textLen: text.length, rich };
        }"""
    )
    if stats["textLen"] < MIN_VISIBLE_TEXT and stats["rich"] < 2:
        raise HTTPException(
            status_code=422,
            detail=f"page too sparse before capture (text={stats['textLen']} rich={stats['rich']})",
        )


async def capture_png(url: str, width: int, height: int, wait_ms: int) -> bytes:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": width, "height": height})
            await page.goto(url, wait_until="networkidle", timeout=60_000)
            await page.wait_for_timeout(wait_ms)
            await page_has_visible_content(page)
            png = await page.screenshot(type="png", full_page=False)
            validate_png(png)
            return png
        finally:
            await browser.close()


@app.get("/health")
async def health():
    return {"status": "ok", "provider": "playwright-chromium", "min_png_bytes": MIN_PNG_BYTES}


@app.post("/v1/screenshots/capture")
async def capture(body: CaptureRequest):
    url = str(body.url)
    width, height = parse_viewport(body.viewport)
    await preflight(url)
    try:
        png = await capture_png(url, width, height, body.wait_ms)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("capture failed for %s", url)
        raise HTTPException(status_code=500, detail="capture failed") from exc
    return Response(content=png, media_type="image/png")


def main():
    import uvicorn

    host = os.environ.get("DIOSCURI_SCREENSHOT_HOST", "0.0.0.0")
    port = int(os.environ.get("DIOSCURI_SCREENSHOT_PORT", "8767"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
