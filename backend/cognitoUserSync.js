require('dotenv').config(); // Load environment variables
const mysql = require('mysql2/promise'); // Use promise-based mysql2
const AWS = require('aws-sdk');

// Initialize AWS Cognito
const cognito = new AWS.CognitoIdentityServiceProvider({
    region: process.env.AWS_REGION
});

// Create a connection to the RDS MySQL database
async function syncCognitoUsersToRDS() {
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

    try {
        console.log('Connected to MySQL database on AWS RDS.');

        // Get Cognito users
        let users = [];
        let params = {
            UserPoolId: process.env.COGNITO_USER_POOL_ID,
            Limit: 60
        };

        let response;
        do {
            response = await cognito.listUsers(params).promise();
            users = users.concat(response.Users);

            // Set pagination token if it exists
            params.PaginationToken = response.PaginationToken;
        } while (response.PaginationToken);

        console.log(`Retrieved ${users.length} users from Cognito.`);

        // Sync users into RDS database
        for (let user of users) {
            const username = user.Username;
            const email = user.Attributes.find(attr => attr.Name === 'email')?.Value || 'no-email';

            const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);

            if (rows.length === 0) {
                console.log(`User ${username} not found in RDS. Inserting...`);

                await db.execute(
                    'INSERT INTO users (username, email) VALUES (?, ?)',
                    [username, email]
                );

                console.log(`Inserted user ${username} into RDS.`);
            } else {
                console.log(`User ${username} already exists in RDS.`);
            }
        }

        console.log('Cognito user data synchronization completed.');
    } catch (error) {
        console.error('Error during synchronization:', error);
    } finally {
        await db.end();
        console.log('MySQL connection closed.');
    }
}

// Run the synchronization process
syncCognitoUsersToRDS().catch(console.error);
