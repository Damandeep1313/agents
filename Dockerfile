# Use a Debian-based Node.js image
FROM node:18-bullseye

# Install zip via apt-get
RUN apt-get update && apt-get install -y zip

# Create app directory inside container
WORKDIR /app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# If you want to copy .env, do it here (Optional)
# COPY .env ./.env

# Expose the port the app runs on
EXPOSE 3000

# Start the server
CMD ["node", "test.js"]
