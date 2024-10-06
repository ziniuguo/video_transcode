require('dotenv').config();
const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const mysql = require('mysql2/promise');

// 初始化 AWS Cognito 客户端
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// 初始化 MySQL 连接
const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: {
        ca: fs.readFileSync(process.env.SSL_CERT_PATH),
        rejectUnauthorized: false
    }
});

// 获取 Cognito 用户池的所有用户
async function getCognitoUsers() {
    const command = new ListUsersCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Limit: 60 // 每次获取最多 60 个用户
    });

    try {
        const data = await cognitoClient.send(command);
        return data.Users; // 返回所有用户数据
    } catch (error) {
        console.error('Error fetching Cognito users:', error);
    }
}

// 检查用户是否已经存在于数据库
async function checkUserInDatabase(username) {
    const [rows] = await db.execute('SELECT username FROM users WHERE username = ?', [username]);
    return rows.length > 0;
}

// 同步用户到数据库
async function syncUserToDatabase(username, email) {
    try {
        await db.execute('INSERT INTO users (username, email) VALUES (?, ?)', [username, email]);
        console.log(`User ${username} synchronized to database.`);
    } catch (error) {
        console.error(`Error inserting user ${username}:`, error);
    }
}

// 主逻辑：同步 Cognito 用户池中的用户到数据库
async function syncCognitoUsersToDatabase() {
    const users = await getCognitoUsers();

    for (const user of users) {
        const username = user.Username;
        const emailAttribute = user.Attributes.find(attr => attr.Name === 'email');
        const email = emailAttribute ? emailAttribute.Value : null;

        // 检查用户是否已经在数据库中
        const userExists = await checkUserInDatabase(username);

        if (!userExists) {
            // 如果用户不存在，插入到数据库
            await syncUserToDatabase(username, email);
        }
    }
}

// 执行同步操作
syncCognitoUsersToDatabase()
    .then(() => {
        console.log('Cognito users synchronized to database.');
        db.end(); // 关闭 MySQL 连接
    })
    .catch(error => {
        console.error('Error during synchronization:', error);
    });
