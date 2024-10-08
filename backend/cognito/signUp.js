require('dotenv').config();

const Cognito = require("@aws-sdk/client-cognito-identity-provider");
const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');

// Cognito and S3 configuration
const clientId = "2olhmm2tshjpl097ncers3h5kq";  // Cognito Client ID
const username = "Aa.123456";  // Replace with the desired username
const password = "Aa.123456";  // Replace with a valid password that meets Cognito requirements
const email = "123456@example.com";  // Replace with the email address to receive the confirmation code

// AWS S3 setup
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// MySQL (RDS) setup
const dbConfig = {
  host: process.env.DB_HOST,  // Make sure this is the correct RDS endpoint
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  ssl: {
    ca: process.env.SSL_CERT_PATH,
    rejectUnauthorized: false,
  }
};

async function main() {
  console.log("Starting user signup process...");

  const client = new Cognito.CognitoIdentityProviderClient({ region: 'ap-southeast-2' });

  // Cognito Sign Up Command
  const command = new Cognito.SignUpCommand({
    ClientId: clientId,
    Username: username,
    Password: password,
    UserAttributes: [{ Name: "email", Value: email }],
  });

  try {
    console.log(`Attempting to sign up user: ${username}`);
    const res = await client.send(command);
    console.log("User signed up successfully:", res);

    // Step 2: Create S3 folder for the user
    console.log(`Attempting to create S3 folder for user: ${username}`);
    await createS3FolderForUser(username);
    console.log(`S3 folder created for user: ${username}`);

    // Step 3: Save user info to RDS database
    console.log(`Attempting to save user ${username} to RDS`);
    await saveUserToRDS(username, email);
    console.log(`User ${username} saved to RDS successfully`);
  } catch (error) {
    console.error("Error during user signup process:", error);
  }
}

// Function to create S3 folder
async function createS3FolderForUser(username) {
  const params = {
    Bucket: process.env.AWS_S3_BUCKET,  // Your S3 bucket name
    Key: `${username}/`,  // The folder path in S3
  };

  try {
    console.log(`Creating S3 folder with bucket: ${process.env.AWS_S3_BUCKET} and key: ${params.Key}`);
    const result = await s3.putObject(params).promise();
    console.log(`S3 folder created successfully for user: ${username}`, result);
  } catch (error) {
    console.error(`Error creating S3 folder for user ${username}:`, error);
    throw error;  // Ensure the error is thrown so it doesn't proceed if this step fails
  }
}

// Function to save user to RDS (MySQL)
async function saveUserToRDS(username, email) {
  try {
    console.log("Establishing connection to RDS...");
    const connection = await mysql.createConnection(dbConfig);
    console.log("Connected to RDS database");

    // Step 2: Insert user into the users table
    const insertQuery = `INSERT INTO users (username, email) VALUES (?, ?)`;
    console.log(`Executing query: ${insertQuery} with values (${username}, ${email})`);
    await connection.execute(insertQuery, [username, email]);

    console.log(`User ${username} inserted into RDS successfully`);

    // Step 3: Close the database connection
    await connection.end();
    console.log("RDS connection closed");
  } catch (error) {
    console.error(`Error saving user to RDS for ${username}:`, error);
    throw error;  // Ensure the error is thrown so it doesn't proceed if this step fails
  }
}

main();
