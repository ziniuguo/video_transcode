require('dotenv').config(); // 加载环境变量
const fs = require('fs');
const path = require('path');
const express = require("express");
const cors = require('cors');
const session = require('express-session');
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const mysql = require('mysql2');
const AWS = require('aws-sdk');
const bcrypt = require('bcrypt');
const os = require('os');

// 确保 ffmpeg 路径正确
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// 配置 AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION
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

// 创建 Express 应用
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

// 设置 multer 存储配置
const storage = multer.memoryStorage(); // 将文件存储到内存中，稍后上传到 S3
const upload = multer({
    storage: storage,
    limits: { fileSize: 1073741824 } // 1 GB
}).single('video');

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
        const originalFileName = req.file.originalname;
        const videoFolder = `${username}/${originalFileName}/`; // 文件夹为用户名/上传文件名
        const fileKey = `${videoFolder}${originalFileName}`; // 原始文件的S3路径

        // 上传文件到 S3
        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileKey,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        };

        try {
            // 上传原始文件到 S3
            await s3.upload(params).promise();

            // 将文件写入本地临时文件夹
            const tempFilePath = path.join(os.tmpdir(), originalFileName);
            fs.writeFileSync(tempFilePath, req.file.buffer);

            // 定义不同分辨率的输出路径
            const outputPaths = [
                { path: path.join(os.tmpdir(), `1080p-${originalFileName}`), resolution: '1920x1080' },
                { path: path.join(os.tmpdir(), `720p-${originalFileName}`), resolution: '1280x720' },
                { path: path.join(os.tmpdir(), `480p-${originalFileName}`), resolution: '854x480' },
                { path: path.join(os.tmpdir(), `360p-${originalFileName}`), resolution: '640x360' }
            ];

            // 转码视频文件
            await Promise.all(outputPaths.map(output => transcodeVideo(tempFilePath, output.path, output.resolution)));

            // 上传转码后的文件到 S3
            await Promise.all(outputPaths.map(output => {
                const transcodeParams = {
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: `${videoFolder}${path.basename(output.path)}`,
                    Body: fs.readFileSync(output.path)
                };
                return s3.upload(transcodeParams).promise();
            }));

            // 删除本地临时文件
            fs.unlinkSync(tempFilePath);
            outputPaths.forEach(output => fs.unlinkSync(output.path));

            res.status(200).send({ msg: 'File uploaded and transcoded successfully' });
        } catch (uploadError) {
            res.status(500).send({ msg: 'Error during file upload or transcoding', error: uploadError.message });
        }
    });
});

// 视频转码函数
function transcodeVideo(inputPath, outputPath, resolution) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('progress', (progress) => {
                console.log(`Transcoding progress: ${progress.percent}%`);
            })
            .on('end', () => {
                console.log(`Transcoding complete: ${outputPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

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
