require('dotenv').config(); // Load environment variables
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
const cookieParser = require('cookie-parser'); // To parse cookies
const { CognitoJwtVerifier } = require('aws-jwt-verify'); // To verify JWT tokens

// Ensure ffmpeg path is correctly set
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// Configure AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION
});

// Cognito configuration
const clientId = process.env.COGNITO_CLIENT_ID;
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// Set up Cognito JWT verification
const verifier = CognitoJwtVerifier.create({
    userPoolId: userPoolId,
    tokenUse: "id", // Verify idToken
    clientId: clientId,
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

// Test database connection
db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL database:', err);
        process.exit(1);
    }
    console.log('Connected to MySQL database on AWS RDS');
});

// Ensure videos table exists
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
app.use(cors({
    origin: true, // Allow all origins
    credentials: true // Allow credentials (cookies)
}));

app.use(cookieParser()); // Use cookie-parser middleware
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

// Serve index.html page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Registration route (using Cognito)
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

        // Create S3 folder for the user
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

// Login route (using Cognito)
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

        if (!authResponse.AuthenticationResult) {
            console.error("Login failed, AuthenticationResult not found:", authResponse);
            return res.status(401).json({ message: 'Login failed, check email confirmation or credentials' });
        }

        const idToken = authResponse.AuthenticationResult.IdToken;
        const accessToken = authResponse.AuthenticationResult.AccessToken;

        console.log("Login successful. Setting cookies.");

        // Set HttpOnly Cookies, inaccessible by JavaScript
        res.cookie('idToken', idToken, { sameSite: 'lax', httpOnly: true, secure: false, path: '/' });
        res.cookie('accessToken', accessToken, { sameSite: 'lax', httpOnly: true, secure: false, path: '/' });

        res.status(200).json({ message: 'Login successful' });
    } catch (error) {
        console.error('Error logging in:', error);
        res.status(401).json({ message: 'Login failed' });
    }
});

// Logout route
app.post('/logout', (req, res) => {
    res.clearCookie('idToken');
    res.clearCookie('accessToken');
    res.status(200).send('Logout successful');
});

// Route to get current user info
app.get('/getUserInfo', ensureAuthenticated, (req, res) => {
    res.json({ username: req.session.user.username });
});

// Route to check or create user folder in S3
app.post('/checkOrCreateFolder/:username', ensureAuthenticated, async (req, res) => {
    const username = req.params.username;

    try {
        // Check or create user folder in S3
        await checkOrCreateUserFolder(username);
        res.status(200).json({ message: 'User folder exists or created successfully' });
    } catch (error) {
        console.error('Error checking/creating user folder:', error);
        res.status(500).json({ message: 'Failed to check/create folder' });
    }
});

// Route to browse user files
app.get('/browse/:username', ensureAuthenticated, (req, res) => {
    const username = req.params.username;

    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: `${username}/`
    };

    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('Error fetching file list from S3:', err);
            return res.status(500).json({ message: 'Error fetching file list' });
        }

        const files = data.Contents.map(file => ({
            filename: file.Key.split('/').pop(),
            fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.amazonaws.com/${file.Key}`
        }));

        res.status(200).json(files);
    });
});

// Route to delete a file
app.delete('/deleteFile/:username/:folderName/:filename', ensureAuthenticated, (req, res) => {
    const { username, folderName, filename } = req.params;

    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `${username}/${folderName}/${filename}`
    };

    s3.deleteObject(params, (err, data) => {
        if (err) {
            console.error('Error deleting file from S3:', err);
            return res.status(500).json({ message: 'Error deleting file' });
        }

        res.status(200).json({ message: 'File deleted successfully' });
    });
});

// Route to delete a folder
app.delete('/deleteFolder/:username/:folderName', ensureAuthenticated, (req, res) => {
    const { username, folderName } = req.params;

    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: `${username}/${folderName}/`
    };

    s3.listObjectsV2(params, (err, data) => {
        if (err) {
            console.error('Error listing folder contents for deletion:', err);
            return res.status(500).json({ message: 'Error deleting folder' });
        }

        const objectsToDelete = data.Contents.map(file => ({ Key: file.Key }));

        if (objectsToDelete.length === 0) {
            return res.status(404).json({ message: 'No files found in folder' });
        }

        const deleteParams = {
            Bucket: process.env.AWS_S3_BUCKET,
            Delete: { Objects: objectsToDelete }
        };

        s3.deleteObjects(deleteParams, (err, data) => {
            if (err) {
                console.error('Error deleting folder contents:', err);
                return res.status(500).json({ message: 'Error deleting folder contents' });
            }

            res.status(200).json({ message: 'Folder and its contents deleted successfully' });
        });
    });
});

// Function to handle video transcoding
const transcodingProgress = {}; // Global progress tracking

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

// Route to check or create user folder in S3
async function checkOrCreateUserFolder(username) {
    const folderKey = `${username}/`;

    const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: folderKey
    };

    try {
        // Check if the folder exists by trying to retrieve its metadata
        await s3.headObject(params).promise();
        console.log(`Folder ${folderKey} already exists in S3.`);
    } catch (err) {
        if (err.code === 'NotFound') {
            // If folder doesn't exist, create it
            console.log(`Folder ${folderKey} not found. Creating it...`);
            const createParams = {
                Bucket: process.env.AWS_S3_BUCKET,
                Key: folderKey,
                Body: ''  // S3 creates folders by uploading an empty object with a key that ends with '/'
            };
            await s3.putObject(createParams).promise();
            console.log(`Folder ${folderKey} created successfully in S3.`);
        } else {
            console.error('Error checking or creating folder:', err);
            throw new Error('Error checking or creating folder in S3');
        }
    }
}

// Upload and transcode route
app.post('/upload', ensureAuthenticated, multer({ storage: multer.memoryStorage() }).single('video'), async (req, res) => {
    if (!req.file) return res.status(400).send({ msg: 'No file selected!' });
    const username = req.session.user.username;
    const originalFileName = path.parse(req.file.originalname).name;
    const videoFolder = `${username}/${originalFileName}/`;
    const tempFolder = path.join(os.tmpdir(), videoFolder);

    try {
        // Step 1: Check if the user's folder exists in S3, and create it if it doesn't
        await checkOrCreateUserFolder(username);

        // Step 2: Proceed with the file upload
        // Ensure directory exists on the server for temporary storage
        if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });
        const tempFilePath = path.join(tempFolder, req.file.originalname);
        fs.writeFileSync(tempFilePath, req.file.buffer);

        console.log('Temp file path:', tempFilePath);
        if (!fs.existsSync(tempFilePath)) {
            console.error('File does not exist after saving:', tempFilePath);
            return res.status(500).send({ msg: 'Error saving file' });
        }

        // Step 3: Transcode video and upload to S3
        const outputFiles = [
            { resolution: '1280x720', path: path.join(tempFolder, `720p-${originalFileName}.mp4`), index: 0, s3Key: `${username}/${originalFileName}/720p-${originalFileName}.mp4` },
            { resolution: '854x480', path: path.join(tempFolder, `480p-${originalFileName}.mp4`), index: 1, s3Key: `${username}/${originalFileName}/480p-${originalFileName}.mp4` },
            { resolution: '640x360', path: path.join(tempFolder, `360p-${originalFileName}.mp4`), index: 2, s3Key: `${username}/${originalFileName}/360p-${originalFileName}.mp4` },
            { resolution: '426x240', path: path.join(tempFolder, `240p-${originalFileName}.mp4`), index: 3, s3Key: `${username}/${originalFileName}/240p-${originalFileName}.mp4` }
        ];

        await Promise.all(outputFiles.map(output => transcodeVideo(tempFilePath, output.path, output.resolution, username, output.index, output.s3Key)));

        res.status(200).send({ msg: 'Files uploaded and transcoded successfully!' });
    } catch (error) {
        console.error('Error during file processing:', error);
        res.status(500).send({ msg: 'Error during file processing' });
    }
});

// Real-time transcoding progress route
app.get('/transcodingProgress', ensureAuthenticated, (req, res) => {
    const username = req.session.user.username;
    if (transcodingProgress[username]) {
        const progress = transcodingProgress[username].reduce((a, b) => a + b, 0) / transcodingProgress[username].length;
        res.json({ progress });
    } else {
        res.json({ progress: 0 });
    }
});

// Middleware to ensure the user is authenticated
async function ensureAuthenticated(req, res, next) {
    const idToken = req.cookies.idToken;

    if (!idToken) {
        return res.status(401).json({ message: 'Unauthorized, please login.' });
    }

    try {
        const payload = await verifier.verify(idToken);
        req.session.user = { username: payload["cognito:username"] };
        next();
    } catch (error) {
        console.error('Invalid token:', error);
        res.status(403).json({ message: 'Forbidden, invalid token.' });
    }
}

// Start the server and listen on 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}, listening on 0.0.0.0`);
});
