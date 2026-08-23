require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from environment variables (set these in Render, never hardcode) ----
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://your-app.onrender.com/auth/callback
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';

// ---- Middleware ----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ---- Simple HTML layout helper ----
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Brongsialor AI</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background:#fbfaf6; color:#1c1c1a; max-width:520px; margin:0 auto; padding:32px 20px; }
  h1 { font-size:24px; }
  a.button, button { display:inline-block; background:#2f5d50; color:#fff; padding:14px 22px; border-radius:8px; text-decoration:none; border:none; font-size:16px; cursor:pointer; }
  .card { border:1px solid #e4e1d8; border-radius:12px; padding:20px; margin:16px 0; }
  input[type=file], input[type=text] { width:100%; padding:10px; margin:10px 0; border:1px solid #ccc; border-radius:6px; }
  .msg { padding:12px; border-radius:8px; margin-bottom:16px; }
  .msg.error { background:#fde2e2; color:#8a1f1f; }
  .msg.success { background:#e2f5e9; color:#1f6b3a; }
  .user { display:flex; align-items:center; gap:10px; margin-bottom:16px; }
  .user img { width:44px; height:44px; border-radius:50%; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---- Home page ----
app.get('/', (req, res) => {
  if (req.session.accessToken) {
    return res.redirect('/dashboard');
  }
  res.send(
    layout(
      'Home',
      `
      <h1>Brongsialor AI</h1>
      <p>Connect your TikTok account to automatically publish your videos.</p>
      <a class="button" href="/auth/login">Log in with TikTok</a>
    `
    )
  );
});

// ---- Step 1: redirect user to TikTok's authorize screen ----
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const scope = 'user.info.basic,video.publish';
  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${CLIENT_KEY}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// ---- Step 2: TikTok redirects back here with ?code=... ----
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(layout('Error', `<div class="msg error">Login was cancelled or failed: ${error}</div><a href="/">Go back</a>`));
  }
  if (state !== req.session.oauthState) {
    return res.send(layout('Error', `<div class="msg error">Invalid state. Please try logging in again.</div><a href="/">Go back</a>`));
  }

  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.send(
        layout('Error', `<div class="msg error">Could not get access token: ${JSON.stringify(tokenData)}</div><a href="/">Go back</a>`)
      );
    }

    req.session.accessToken = tokenData.access_token;
    req.session.refreshToken = tokenData.refresh_token;
    req.session.openId = tokenData.open_id;

    res.redirect('/dashboard');
  } catch (err) {
    res.send(layout('Error', `<div class="msg error">Something went wrong: ${err.message}</div><a href="/">Go back</a>`));
  }
});

// ---- Dashboard: show profile + upload form ----
app.get('/dashboard', async (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');

  let user = { display_name: 'TikTok user', avatar_url: '' };
  try {
    const infoRes = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
      { headers: { Authorization: `Bearer ${req.session.accessToken}` } }
    );
    const infoData = await infoRes.json();
    if (infoData.data && infoData.data.user) user = infoData.data.user;
  } catch (e) {
    /* non-fatal, we still show the page */
  }

  const successMsg = req.query.success ? `<div class="msg success">${req.query.success}</div>` : '';
  const errorMsg = req.query.error ? `<div class="msg error">${req.query.error}</div>` : '';

  res.send(
    layout(
      'Dashboard',
      `
      <h1>Dashboard</h1>
      ${successMsg}${errorMsg}
      <div class="user">
        ${user.avatar_url ? `<img src="${user.avatar_url}">` : ''}
        <strong>${user.display_name}</strong>
      </div>
      <div class="card">
        <form action="/upload" method="POST" enctype="multipart/form-data">
          <label>Video file (mp4)</label>
          <input type="file" name="video" accept="video/mp4" required>
          <label>Caption</label>
          <input type="text" name="caption" placeholder="Write a caption...">
          <button type="submit">Publish to TikTok</button>
        </form>
      </div>
      <a href="/logout">Log out</a>
    `
    )
  );
});

// ---- Handle video upload + publish to TikTok (FILE_UPLOAD flow) ----
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  const filePath = req.file.path;
  const videoSize = req.file.size;
  const caption = req.body.caption || '';

  try {
    // Step 1: initialize the post
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          privacy_level: 'SELF_ONLY', // sandbox / unapproved apps must use SELF_ONLY
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      }),
    });
    const initData = await initRes.json();

    if (!initData.data || !initData.data.upload_url) {
      fs.unlinkSync(filePath);
      return res.redirect('/dashboard?error=' + encodeURIComponent('Init failed: ' + JSON.stringify(initData)));
    }

    const { upload_url, publish_id } = initData.data;

    // Step 2: upload the video bytes to the upload_url TikTok gave us
    const fileBuffer = fs.readFileSync(filePath);
    await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: fileBuffer,
    });

    fs.unlinkSync(filePath); // clean up local temp file

    res.redirect('/dashboard?success=' + encodeURIComponent('Video submitted! publish_id: ' + publish_id));
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.redirect('/dashboard?error=' + encodeURIComponent('Upload failed: ' + err.message));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => {
  console.log(`Brongsialor AI running on port ${PORT}`);
});
