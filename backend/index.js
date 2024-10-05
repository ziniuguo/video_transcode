require('dotenv').config();
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

// Configure ffmpeg path
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// AWS S3 Configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION
});

// MySQL connection configuration
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

// Test MySQL connection
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

// Session management
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 60 * 1000 // 10 minutes
    }
}));

// Set static file path
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Registration route
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const query = "INSERT INTO users (username, password) VALUES (?, ?)";
        db.query(query, [username, hashedPassword], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ message: 'Username already exists' });
                } else {
                    return res.status(500).json({ message: 'Database error' });
                }
            }

            // Create S3 folder for user
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
        });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Login route
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

// Logout route
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Logout failed');
        }
        res.send('Logout successful');
    });
});

// Get user info route
app.get('/getUserInfo', ensureAuthenticated, (req, res) => {
    if (req.session.user) {
        res.json({ username: req.session.user.username });
    } else {
        res.status(401).json({ message: 'User not authenticated' });
    }
});

// Upload route
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
        const videoFolder = `${username}/${originalFileName}/`;
        const fileKey = `${videoFolder}${originalFileName}`;

        // Upload original file to S3
        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileKey,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        };

        try {
            await s3.upload(params).promise();

            // Write file to local temp directory
            const tempFilePath = path.join(os.tmpdir(), originalFileName);
            fs.writeFileSync(tempFilePath, req.file.buffer);

            // Transcode video
            const resolutions = [
                { suffix: '1080p', resolution: '1920x1080' },
                { suffix: '720p', resolution: '1280x720' },
                { suffix: '480p', resolution: '854x480' },
                { suffix: '360p', resolution: '640x360' }
            ];

            const outputPaths = resolutions.map(res => {
                return { path: path.join(os.tmpdir(), `${res.suffix}-${originalFileName}`), resolution: res.resolution };
            });

            await Promise.all(outputPaths.map(output => transcodeVideo(tempFilePath, output.path, output.resolution)));

            // Upload transcoded files to S3
            await Promise.all(outputPaths.map(output => {
                const transcodeParams = {
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: `${videoFolder}${path.basename(output.path)}`,
                    Body: fs.readFileSync(output.path)
                };
                return s3.upload(transcodeParams).promise();
            }));

            // Clean up local temp files
            fs.unlinkSync(tempFilePath);
            outputPaths.forEach(output => fs.unlinkSync(output.path));

            res.status(200).send({ msg: 'File uploaded and transcoded successfully' });
        } catch (uploadError) {
            res.status(500).send({ msg: 'Error during file upload or transcoding', error: uploadError.message });
        }
    });
});

// Browse user files route
app.get('/browse/:username', ensureAuthenticated, (req, res) => {
    const { username } = req.params;
    if (req.session.user.username !== username) {
        return res.status(403).json({ message: 'You are not authorized to browse this user files.' });
    }
    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: `${username}/`
    };
    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('Error fetching files from S3:', err);
            return res.status(500).json({ message: 'Error fetching files from S3' });
        }

        const fileLinks = {};
        data.Contents.forEach(item => {
            const keyParts = item.Key.split('/');
            const folderName = keyParts[1];
            const filename = keyParts[2];
            if (!fileLinks[folderName]) {
                fileLinks[folderName] = [];
            }
            if (filename) {
                fileLinks[folderName].push({
                    filename: filename,
                    fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`
                });
            }
        });
        res.json(fileLinks);
    });
});

// Middleware to ensure user is authenticated
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ message: 'Please login to access this page' });
    }
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}, listening on 0.0.0.0`);
});
