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
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg"); // 确保路径正确

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

// 上传并转码的路由，文件存储到 S3，视频元数据存储到 RDS
app.post('/upload', ensureAuthenticated, (req, res) => {
    console.log('Upload request received for user:', req.session.user.username);

    upload(req, res, async (err) => {
        if (err) {
            console.error('Error during file upload:', err);
            return res.status(400).send({ msg: err.message || 'File upload error' });
        }
        if (!req.file) {
            console.error('No file selected for upload');
            return res.status(400).send({ msg: 'No file selected!' });
        }

        const username = req.session.user.username;
        const originalFileName = req.file.originalname;
        console.log(`Uploading file: ${originalFileName} for user: ${username}`);

        const videoFolder = `${username}/${originalFileName}/`; // 用户名为根目录，文件名为子目录
        const fileKey = `${videoFolder}${originalFileName}`; // 文件的S3路径

        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileKey,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        };

        try {
            // 上传原始文件到 S3
            console.log('Uploading original file to S3 with key:', fileKey);
            await s3.upload(params).promise();
            console.log('File uploaded to S3 successfully');

            // 将文件写入本地临时文件夹
            const tempFilePath = path.join(os.tmpdir(), originalFileName);
            fs.writeFileSync(tempFilePath, req.file.buffer);

            // 定义转码输出路径和分辨率
            const resolutions = [
                { suffix: '1080p', resolution: '1920x1080' },
                { suffix: '720p', resolution: '1280x720' },
                { suffix: '480p', resolution: '854x480' },
                { suffix: '360p', resolution: '640x360' }
            ];

            // 转码视频并存储到本地临时文件夹
            const outputPaths = resolutions.map(res => {
                return { path: path.join(os.tmpdir(), `${res.suffix}-${originalFileName}`), resolution: res.resolution };
            });

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
            console.log('Transcoding completed and temporary files deleted');

            // 将文件信息存储到 RDS
            const videoId = randomUUID(); // 使用 UUID 作为视频的唯一标识
            const videoQuery = "INSERT INTO videos (id, username, filename, s3_key) VALUES (?, ?, ?, ?)";
            db.query(videoQuery, [videoId, username, originalFileName, fileKey], (err) => {
                if (err) {
                    console.error('Error saving video metadata to RDS:', err);
                    return res.status(500).send({ msg: 'Error saving video metadata to RDS' });
                }
                res.status(200).send({
                    msg: 'File uploaded to S3 and metadata saved in RDS!',
                    fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`
                });
            });
        } catch (uploadError) {
            console.error('Error during upload process:', uploadError);
            res.status(500).send({ msg: 'Error uploading file to S3', error: uploadError.message });
        }
    });
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