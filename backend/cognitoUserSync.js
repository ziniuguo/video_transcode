require('dotenv').config(); // Load environment variables
const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');

// Configure AWS Cognito
const cognito = new AWS.CognitoIdentityServiceProvider({
    region: process.env.AWS_REGION
});

// MySQL connection configuration
async function connectToDatabase() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT,
        ssl: {
            ca: process.env.SSL_CERT_PATH,
            rejectUnauthorized: false
        }
    });
    console.log('Connected to MySQL database on AWS RDS.');
    return db;
}

// Function to fetch all users from the Cognito User Pool
async function getCognitoUsers() {
    const params = {
        UserPoolId: process.env.COGNITO_USER_POOL_ID
    };

    let users = [];
    let response;

    do {
        response = await cognito.listUsers(params).promise();
        users = users.concat(response.Users);
        params.PaginationToken = response.PaginationToken;
    } while (response.PaginationToken);

    console.log(`Retrieved ${users.length} users from Cognito.`);
    return users;
}

// Function to sync Cognito users with MySQL RDS
async function syncCognitoUsersToRDS() {
    const db = await connectToDatabase();
    try {
        const users = await getCognitoUsers();

        for (let user of users) {
            const username = user.Username;

            // Check if the user already exists in RDS
            const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);

            if (rows.length === 0) {
                console.log(`User ${username} not found in RDS. Inserting...`);

                // Insert only the username into the MySQL database
                await db.execute(
                    'INSERT INTO users (username) VALUES (?)',
                    [username]
                );

                console.log(`Inserted user ${username} into RDS.`);
            } else {
                console.log(`User ${username} already exists in RDS.`);
            }
        }
    } catch (error) {
        console.error('Error during synchronization:', error);
    } finally {
        await db.end();
        console.log('MySQL connection closed.');
    }
}

// Run the synchronization function
syncCognitoUsersToRDS();
