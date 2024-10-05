require('dotenv').config(); // 加载环境变量
const fs = require('fs');
const { randomUUID } = require('crypto');
const express = require("express");
const cors = require('cors');
const session = require('express-session');
const multer = require("multer");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const mysql = require('mysql2');
const AWS = require('aws-sdk');
const bcrypt = require('bcrypt');
const os = require('os');

// 确保 ffmpeg 路径正确
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg"); // 指定安装的 ffmpeg 路径

// 配置 AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION
});

// 启动时检查 S3 的连接性
s3.listBuckets((err, data) => {
    if (err) {
        console.log("S3 Connection Error:", err);
    } else {
        console.log("S3 Connection Success. Total Buckets: ", data.Buckets.length);
    }
});

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

// 确保 users 表存在
const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) PRIMARY KEY,
    password VARCHAR(255) NOT NULL
)`;
db.query(createUsersTable, (err) => {
    if (err) {
        console.error('Error creating users table:', err);
    } else {
        console.log('Users table ensured.');
    }
});

// 确保 videos 表存在
const createVideosTable = `
CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    s3_key VARCHAR(255) NOT NULL,
    upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (username) REFERENCES users(username)
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

// 注册路由
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10); // 加密密码
        const query = "INSERT INTO users (username, password) VALUES (?, ?)";
        db.query(query, [username, hashedPassword], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ message: 'Username already exists' });
                } else {
                    return res.status(500).json({ message: 'Database error' });
                }
            }

            // 创建 S3 文件夹
            const params = {
                Bucket: process.env.AWS_S3_BUCKET,
                Key: `${username}/` // S3 中的文件夹以斜杠结尾
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
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 登录路由
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const query = "SELECT * FROM users WHERE username = ?";
    db.query(query, [username], async (err, results) => {
        if (err) {
            return res.status(500).json({ message: 'Database error' });
        } else if (results.length > 0) {
            const match = await bcrypt.compare(password, results[0].password);
            if (match) {
                req.session.user = { username: results[0].username };
                return res.status(200).json({ message: 'Login successful' });
            } else {
                return res.status(401).json({ message: 'Login failed' });
            }
        } else {
            return res.status(401).json({ message: 'Login failed' });
        }
    });
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

let transcodingProgress = {}; // 全局存储每个用户的转码进度

// 视频转码函数
function transcodeVideo(inputPath, outputPath, resolution, username, resolutionIndex) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('progress', (progress) => {
                if (!transcodingProgress[username]) {
                    transcodingProgress[username] = [0, 0, 0, 0]; // 初始化四个分辨率的进度
                }
                transcodingProgress[username][resolutionIndex] = progress.percent; // 存储当前分辨率的进度
                console.log(`Transcoding progress for ${resolution} of ${username}: ${progress.percent}%`);
            })
            .on('end', () => {
                transcodingProgress[username][resolutionIndex] = 100; // 完成后设置为 100%
                console.log(`Transcoding complete for ${resolution}: ${outputPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file for ${resolution}: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

// 上传并转码的路由，文件存储到 S3，视频元数据存储到 RDS
app.post('/upload', ensureAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).send({ msg: err });
        }
        if (!req.file) {
            return res.status(400).send({ msg: 'No file selected!' });
        }

        const username = req.session.user.username;
        const originalFileName = path.parse(req.file.originalname).name;  // 不包括扩展名的文件名
        const videoFolder = `${username}/${originalFileName}/`;  // 用户文件夹 + 上传文件名为子文件夹
        const tempFolder = path.join(os.tmpdir(), videoFolder);

        // 创建本地目录
        if (!fs.existsSync(tempFolder)) {
            fs.mkdirSync(tempFolder, { recursive: true });
        }

        const tempFilePath = path.join(tempFolder, req.file.originalname);
        fs.writeFileSync(tempFilePath, req.file.buffer);

        // 定义不同分辨率输出文件路径
        const outputFiles = [
            { resolution: '1280x720', path: path.join(tempFolder, `720p-${originalFileName}.mp4`), index: 0 },
            { resolution: '854x480', path: path.join(tempFolder, `480p-${originalFileName}.mp4`), index: 1 },
            { resolution: '640x360', path: path.join(tempFolder, `360p-${originalFileName}.mp4`), index: 2 },
            { resolution: '426x240', path: path.join(tempFolder, `240p-${originalFileName}.mp4`), index: 3 }
        ];

        try {
            // 并行处理每个分辨率的转码
            await Promise.all(outputFiles.map(output =>
                transcodeVideo(tempFilePath, output.path, output.resolution, username, output.index)
            ));

            res.status(200).send({ msg: 'Files uploaded and transcoded successfully!' });
        } catch (uploadError) {
            console.error('Error during file processing:', uploadError);
            res.status(500).send({ msg: 'Error during file processing' });
        }
    });
});

// 浏览用户文件的路由
app.get('/browse/:username', ensureAuthenticated, (req, res) => {
    const { username } = req.params;
    if (req.session.user.username !== username) {
        return res.status(403).json({ message: 'You are not authorized to browse this user\'s files.' });
    }
    // 在这里从 S3 获取用户的文件列表
    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: `${username}/`
    };
    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('Error fetching files from S3:', err);
            return res.status(500).json({ message: 'Error fetching files from S3' });
        }
        const fileLinks = data.Contents.map(item => ({
            folderName: item.Key.split('/')[1],
            filename: item.Key.split('/')[2],
            fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`
        }));
        res.json(fileLinks); // 返回 JSON 数据
    });
});

// 获取转码进度的路由
app.get('/transcodingProgress', ensureAuthenticated, (req, res) => {
    const username = req.session.user.username;
    const progressArray = transcodingProgress[username] || [0, 0, 0, 0]; // 获取用户的进度数组，默认为 0
    const totalProgress = progressArray.reduce((sum, progress) => sum + progress, 0) / 4; // 计算平均进度
    res.json({ progress: totalProgress });
});

// 获取当前登录用户信息
app.get('/getUserInfo', ensureAuthenticated, (req, res) => {
    if (req.session.user) {
        res.json({ username: req.session.user.username });
    } else {
        res.status(401).json({ message: 'User not authenticated' });
    }
});

// 设置 multer 存储配置
const storage = multer.memoryStorage(); // 将文件存储到内存中，稍后上传到 S3

// multer 配置
const upload = multer({
    storage: storage,
    limits: { fileSize: 1073741824 } // 1 GB
}).single('video');

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
