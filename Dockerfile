# Use official Node.js 24 Alpine image for minimal footprint and native TypeScript support
FROM node:24-alpine

WORKDIR /app

# Install dependencies with frozen lockfile, omitting devDependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source code and static web interface assets
COPY src/ ./src/
COPY public/ ./public/

# Set production environment defaults
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check endpoint for Koyeb, container orchestrators, and uptime monitors
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Launch the server using Node 24 native experimental type-stripping
CMD ["node", "--experimental-strip-types", "src/server.ts"]
