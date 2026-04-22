# Single-stage build: Node 20 + Playwright Chromium
#
# We use node:20-bookworm (full Debian) because Playwright needs
# system libraries for Chromium. The `npx playwright install` command
# handles both the browser binary and OS dependencies.

FROM node:20-bookworm

WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install only Chromium + its OS dependencies (skips Firefox/WebKit)
RUN npx playwright install --with-deps chromium

# Copy application code
COPY src/ ./src/

ENV NODE_ENV=production
ENV HEADLESS=true
ENV SLOW_MO=0

# The server listens on this port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
