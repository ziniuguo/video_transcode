require('dotenv').config(); // 加载环境变量
const fs = require('fs');
const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const mysql = require('mysql2');
const AWS = require('aws-sdk');
const os = require('os');
const { CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand } = require('@aws-sdk/client-cognito-identity-provider');

// 确保 ffmpeg 路径正确
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// 配置 AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION
});

// Cognito 配置
const clientId = process.env.COGNITO_CLIENT_ID;
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// MySQL 连接配置
const db = mysql.createConnection({
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

// 测试数据库连接
db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL database:', err);
        process.exit(1);
    }
    console.log('Connected to MySQL database on AWS RDS');
});

// 确保 videos 表存在
const createVideosTable = `
CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    s3_key VARCHAR(255) NOT NULL,
    upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;
db.query(createVideosTable, (err) => {
    if (err) {
        console.error('Error creating videos table:', err);
    } else {
        console.log('Videos table ensured.');
    }
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 设置会话管理
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 60 * 1000 // 10 分钟
    }
}));

// 设置静态文件路径
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// 提供 index.html 页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// 注册路由 (使用 Cognito)
app.post('/register', async (req, res) => {
    const { username, password, email } = req.body;
    try {
        const signUpCommand = new SignUpCommand({
            ClientId: clientId,
            Username: username,
            Password: password,
            UserAttributes: [{ Name: "email", Value: email }]
        });

        const signUpResponse = await cognitoClient.send(signUpCommand);
        console.log('User registered successfully:', signUpResponse);

        // 为用户创建 S3 文件夹
        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: `${username}/`
        };

        s3.putObject(params, (s3Err) => {
            if (s3Err) {
                console.error('Error creating folder in S3:', s3Err);
                return res.status(500).json({ message: 'User registered but failed to create folder in S3' });
            } else {
                console.log(`S3 folder created for user: ${username}`);
                return res.status(201).json({ message: 'User registered successfully and S3 folder created' });
            }
        });
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 登录路由 (使用 Cognito)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const authCommand = new InitiateAuthCommand({
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: clientId,
            AuthParameters: {
                USERNAME: username,
                PASSWORD: password
            }
        });

        const authResponse = await cognitoClient.send(authCommand);
        req.session.user = { username }; // 保存会话
        console.log('Login successful:', authResponse);

        // 检查用户 S3 文件夹是否存在
        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Prefix: `${username}/`
        };

        s3.listObjectsV2(params, (err, data) => {
            if (err) {
                console.error(`Error checking S3 folder for user ${username}:`, err);
                return res.status(500).json({ message: 'Error checking S3 folder' });
            }

            // 如果没有找到文件夹，则创建它
            if (data.KeyCount === 0) {
                const createFolderParams = {
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: `${username}/`
                };

                s3.putObject(createFolderParams, (s3Err) => {
                    if (s3Err) {
                        console.error('Error creating folder in S3:', s3Err);
                        return res.status(500).json({ message: 'Login successful, but failed to create S3 folder' });
                    } else {
                        console.log(`S3 folder created for user: ${username}`);
                    }
                });
            }
        });

        res.status(200).json({ message: 'Login successful' });
    } catch (error) {
        console.error('Error logging in:', error);
        res.status(401).json({ message: 'Login failed' });
    }
});

// 注销路由
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Logout failed');
        }
        res.send('Logout successful');
    });
});

// 视频转码函数
const transcodingProgress = {}; // 全局进度记录

function transcodeVideo(inputPath, outputPath, resolution, username, resolutionIndex, s3Key) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('progress', (progress) => {
                if (!transcodingProgress[username]) {
                    transcodingProgress[username] = [0, 0, 0, 0];
                }
                transcodingProgress[username][resolutionIndex] = progress.percent;
            })
            .on('end', () => {
                transcodingProgress[username][resolutionIndex] = 100;
                fs.readFile(outputPath, (err, fileData) => {
                    if (err) return reject(err);
                    const params = { Bucket: process.env.AWS_S3_BUCKET, Key: s3Key, Body: fileData };
                    s3.upload(params, (err, data) => {
                        if (err) return reject(err);
                        const query = `INSERT INTO videos (id, username, filename, s3_key) VALUES (?, ?, ?, ?)`;
                        db.query(query, [randomUUID(), username, path.basename(outputPath), s3Key], (err) => {
                            if (err) return reject(err);
                            resolve();
                        });
                    });
                });
            })
            .on('error', (err) => reject(err))
            .run();
    });
}

// 上传并转码的路由
app.post('/upload', ensureAuthenticated, multer({ storage: multer.memoryStorage() }).single('video'), async (req, res) => {
    if (!req.file) return res.status(400).send({ msg: 'No file selected!' });
    const username = req.session.user.username;
    const originalFileName = path.parse(req.file.originalname).name;
    const videoFolder = `${username}/${originalFileName}/`;
    const tempFolder = path.join(os.tmpdir(), videoFolder);
    if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });
    const tempFilePath = path.join(tempFolder, req.file.originalname);
    fs.writeFileSync(tempFilePath, req.file.buffer);

    const outputFiles = [
        { resolution: '1280x720', path: path.join(tempFolder, `720p-${originalFileName}.mp4`), index: 0, s3Key: `${username}/${originalFileName}/720p-${originalFileName}.mp4` },
        { resolution: '854x480', path: path.join(tempFolder, `480p-${originalFileName}.mp4`), index: 1, s3Key: `${username}/${originalFileName}/480p-${originalFileName}.mp4` },
        { resolution: '640x360', path: path.join(tempFolder, `360p-${originalFileName}.mp4`), index: 2, s3Key: `${username}/${originalFileName}/360p-${originalFileName}.mp4` },
        { resolution: '426x240', path: path.join(tempFolder, `240p-${originalFileName}.mp4`), index: 3, s3Key: `${username}/${originalFileName}/240p-${originalFileName}.mp4` }
    ];

    try {
        await Promise.all(outputFiles.map(output => transcodeVideo(tempFilePath, output.path, output.resolution, username, output.index, output.s3Key)));
        res.status(200).send({ msg: 'Files uploaded and transcoded successfully!' });
    } catch (uploadError) {
        console.error('Error during file processing:', uploadError);
        res.status(500).send({ msg: 'Error during file processing' });
    }
});

// 确保用户已认证的中间件
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ message: 'Please login to access this page' });
    }
}

// 启动服务器并监听 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}, listening on 0.0.0.0`);
});
