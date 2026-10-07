FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SEGMENT_SECONDS=600

# System deps: Chrome, Xvfb, PulseAudio, ffmpeg, VNC stack, headless-Chrome runtime libs.
# No WM (fluxbox) or unclutter — Chrome runs without kiosk/fullscreen, so x11grab
# captures the bare X display directly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates \
    xvfb pulseaudio ffmpeg \
    x11vnc websockify novnc \
    fonts-liberation libnss3 libgbm1 libasound2 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgtk-3-0 libpango-1.0-0 libcairo2 \
    libxshmfence1 \
 && wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh

RUN chmod +x ./entrypoint.sh && npm install && npm run build && npm prune --omit=dev

ENTRYPOINT ["./entrypoint.sh"]