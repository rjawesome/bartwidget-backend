FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker layer caching
# Dependencies will only be re-installed if these files change
COPY package*.json ./

RUN npm install

# Copy the rest of the application files
COPY . .

RUN npm run build

# Assuming your package.json has a "start" script. Adjust if you use a different command like "npx ts-node src/index.ts"
CMD ["npm", "start"]