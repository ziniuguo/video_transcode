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
ffmpeg.setFfmpegPath("/snap/bin/ffmpeg"); // 指定服务器上安装的 ffmpeg 路径

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
        // 打印前5个存储桶名称
        const sampleBuckets = data.Buckets.slice(0, 5).map(bucket => bucket.Name);
        console.log("Sample Buckets: ", sampleBuckets);
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

// 加载文件列表
function loadFileList() {
    if (!sessionUsername) {
        console.error('No session username found');
        document.getElementById('fileLinks').innerText = 'Cannot load file list without username.';
        return;
    }

    fetch('http://3.25.114.97:3000/browse/' + encodeURIComponent(sessionUsername), {
        credentials: 'include'
    })
        .then(response => response.json())
        .then(fileList => {
            const fileLinksDiv = document.getElementById('fileLinks');
            fileLinksDiv.innerHTML = ''; // 清空之前的内容

            fileList.forEach(file => {
                const link = document.createElement('a');
                link.href = file.fileUrl;
                link.textContent = file.filename;
                link.target = '_blank'; // 打开新窗口查看视频
                fileLinksDiv.appendChild(link);
                fileLinksDiv.appendChild(document.createElement('br')); // 添加换行符
            });
        })
        .catch(error => {
            console.error('Error:', error);
            document.getElementById('fileLinks').innerText = 'An error occurred while fetching file list: ' + error.message;
        });
}


// 列出用户的子目录 API
app.get('/listFolders/:username', ensureAuthenticated, (req, res) => {
    const { username } = req.params;
    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: `${username}/`,
        Delimiter: '/' // 只列出文件夹（前缀）
    };

    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('Error fetching folders from S3:', err);
            return res.status(500).json({ message: 'Error fetching folders from S3' });
        }

        const folders = data.CommonPrefixes.map(prefix => ({
            folderName: prefix.Prefix.split('/')[1] // 提取子目录名称
        }));

        res.json(folders);  // 返回文件夹列表
    });
});

// 删除文件夹的路由
app.delete('/deleteFolder/:username/:folder', ensureAuthenticated, (req, res) => {
    const { username, folder } = req.params;
    const prefix = `${username}/${folder}/`; // 定义要删除的文件夹路径

    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: prefix
    };

    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            return res.status(500).json({ message: 'Error fetching files from S3' });
        }

        const objectsToDelete = data.Contents.map(item => ({ Key: item.Key }));

        if (objectsToDelete.length === 0) {
            return res.status(404).json({ message: 'Folder not found' });
        }

        const deleteParams = {
            Bucket: process.env.AWS_S3_BUCKET,
            Delete: { Objects: objectsToDelete }
        };

        s3.deleteObjects(deleteParams, (deleteErr) => {
            if (deleteErr) {
                return res.status(500).json({ message: 'Error deleting folder' });
            }

            res.json({ message: 'Folder deleted successfully' });
        });
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
            filename: item.Key,
            fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`
        }));
        res.json(fileLinks); // 返回 JSON 数据
    });
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
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).send({ msg: err });
        }
        if (!req.file) {
            return res.status(400).send({ msg: 'No file selected!' });
        }

        const username = req.session.user.username;
        const originalFileName = req.file.originalname;
        const videoFolder = `${username}/${originalFileName}/`; // 用户名为根目录，文件名为子目录
        const fileKey = `${videoFolder}${originalFileName}`; // 文件的S3路径

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

            // 转码视频
            const outputPaths = [
                { path: `${videoFolder}720p-${originalFileName}`, resolution: '1280x720' },
                { path: `${videoFolder}480p-${originalFileName}`, resolution: '854x480' },
                { path: `${videoFolder}360p-${originalFileName}`, resolution: '640x360' }
            ];

            await Promise.all(outputPaths.map(output => transcodeVideo(tempFilePath, output.path, output.resolution)));

            // 删除本地临时文件
            fs.unlinkSync(tempFilePath);

            // 将文件信息存储到 RDS
            const videoId = randomUUID(); // 使用 UUID 作为视频的唯一标识
            const videoQuery = "INSERT INTO videos (id, username, filename, s3_key) VALUES (?, ?, ?, ?)";
            db.query(videoQuery, [videoId, username, originalFileName, fileKey], (err) => {
                if (err) {
                    console.error('Error saving video metadata to RDS:', err);
                    res.status(500).send({ msg: 'Error saving video metadata to RDS' });
                } else {
                    res.status(200).send({
                        msg: 'File uploaded to S3 and metadata saved in RDS!',
                        fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`
                    });
                }
            });
        } catch (uploadError) {
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
