# Use the official Node.js image as the base image
FROM node:20

# Set the working directory inside the container for the backend
WORKDIR /app/backend

# Copy package.json and package-lock.json from the backend directory to the working directory
COPY backend/package*.json ./

# Install the dependencies
RUN npm install

# Copy the backend code to the working directory
COPY backend/ .

# Copy the frontend directory to a separate location inside the container
WORKDIR /app/frontend
COPY frontend/ .

# Rebuild native dependencies for Linux environment in the backend
WORKDIR /app/backend
RUN npm rebuild sqlite3

# Expose the port your app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "index.js"]
