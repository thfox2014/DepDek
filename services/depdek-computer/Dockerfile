FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /opt/depdek-computer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs client.mjs policy.mjs ./
USER pwuser
ENV HOME=/tmp DEPDEK_COMPUTER_HOSTS=example.com
CMD ["node", "server.mjs"]
