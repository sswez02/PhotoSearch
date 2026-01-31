FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN ls -la && echo "----" && ls -la /app
RUN npm ci
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/migrations /app/migrations
EXPOSE 8080
CMD ["node", "dist/index.js"]