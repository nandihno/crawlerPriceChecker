FROM apify/actor-node-playwright-chrome:20-1.59.1

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages"

COPY --chown=myuser . ./

CMD npm start --silent
