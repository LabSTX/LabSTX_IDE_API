import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import multer from 'multer';
import AdmZip from 'adm-zip';

dotenv.config();

const __apiDir = path.dirname(fileURLToPath(import.meta.url));
const execPromise = promisify(exec);
const app = express();
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "https://lab-stx-ide.vercel.app",
        ],
    })
);
app.use(express.json());
app.use(cookieParser());

const PORT = 5001;
const DEPLOYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

const WORKSPACE_PREFIX = 'lab-stx-';
const MAX_IDLE_TIME_MS = 15 * 60 * 1000; // 15 minutes
const upload = multer({ dest: os.tmpdir() });

const getWorkspacePath = (sessionId: string) => {
    const cleanId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(os.tmpdir(), `${WORKSPACE_PREFIX}${cleanId}`);
};

// Storage for REPL history per session
const replHistory: string[] = [];

// Determine the path to the Clarinet binary
const getClarinetPath = () => {
    // Check 1: Adjacent bin folder (standalone deployment)
    const localBin = path.join(__apiDir, 'bin', 'clarinet');
    if (fs.existsSync(localBin)) return localBin;

    // Check 2: Process CWD bin (common for some hosting)
    const cwdBin = path.join(process.cwd(), 'bin', 'clarinet');
    if (fs.existsSync(cwdBin)) return cwdBin;

    // Fallback: System path
    return 'clarinet';
};

const CLARINET_CMD = getClarinetPath();
console.log(`[CLI] Using Clarinet command: ${CLARINET_CMD}`);

// 1. Health Check
app.get('/ide-api/health', (req, res) => {
    res.json({ status: 'ok', engine: 'Clarinet CLI' });
});

// 1.5 Init Project
app.post('/ide-api/project/init', upload.single('workspace'), async (req, res) => {
    const sessionId = req.body.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    if (!req.file) return res.status(400).json({ error: 'Missing workspace zip' });

    const workspaceDir = getWorkspacePath(sessionId);

    try {
        if (fs.existsSync(workspaceDir)) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
        fs.mkdirSync(workspaceDir, { recursive: true });

        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(workspaceDir, true);

        // Clean up uploaded zip
        fs.unlinkSync(req.file.path);

        // Fix GitHub zip structure (if there's exactly one root folder, move its contents up)
        const entries = fs.readdirSync(workspaceDir);
        if (entries.length === 1) {
            const possibleRoot = path.join(workspaceDir, entries[0]);
            if (fs.statSync(possibleRoot).isDirectory()) {
                const innerEntries = fs.readdirSync(possibleRoot);
                for (const entry of innerEntries) {
                    fs.renameSync(path.join(possibleRoot, entry), path.join(workspaceDir, entry));
                }
                fs.rmdirSync(possibleRoot);
            }
        }

        // Ensure Clarinet.toml exists
        const tomlPath = path.join(workspaceDir, 'Clarinet.toml');
        if (!fs.existsSync(tomlPath)) {
            let clarinetToml = `[project]\nname = "labstx-project"\nauthors = []\ntelemetry = false\nrequirements = []\n[repl]\ncosts_version = 2\nparser_version = 2\n\n`;

            // Auto-detect contracts
            const contractsDir = path.join(workspaceDir, 'contracts');
            if (fs.existsSync(contractsDir)) {
                clarinetToml += "[contracts]\n";
                const files = fs.readdirSync(contractsDir);
                files.forEach(f => {
                    if (f.endsWith('.clar')) {
                        const cleanName = f.replace(/\.clar$/, '');
                        clarinetToml += `\n[contracts.${cleanName}]\npath = "contracts/${f}"\ndepends_on = []\n`;
                    }
                });
            }
            fs.writeFileSync(tomlPath, clarinetToml);
        }

        const settingsDir = path.join(workspaceDir, 'settings');
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
            const simnetToml = `[network]\nname = "simnet"\n[accounts.deployer]\nmnemonic = "twice kind fence tip hidden tilt action fragile skin nothing glory cousin green tomorrow spring wrist shed math olympic multiply hip blue scout claw"\nbalance = 100000000000000\n[accounts.wallet_1]\nmnemonic = "sell invite acquire kitten bamboo drastic jelly vivid peace spawn twice guilt pave pen trash pretty park cube fragile unaware remain midnight betray rebuild"\nbalance = 100000000000000`;
            fs.writeFileSync(path.join(settingsDir, 'Simnet.toml'), simnetToml);
            fs.writeFileSync(path.join(settingsDir, 'Devnet.toml'), simnetToml);
        }

        console.log(`[CLI] Initialized workspace ${workspaceDir} for session ${sessionId}, running check...`);
        const { stdout, stderr } = await execPromise(`${CLARINET_CMD} check`, { cwd: workspaceDir });
        const output = (stdout || "") + (stderr || "");

        const now = new Date();
        fs.utimesSync(workspaceDir, now, now);

        res.json({ success: true, output, errors: [] });
    } catch (err: any) {
        let output = (err.stdout || "") + (err.stderr || "");
        const errLines = output.split('\n').filter((l: string) => l.includes('error:') || l.includes('syntax error'));
        const errors = errLines.length > 0 ? errLines : [err.message || "Init failed"];
        res.status(500).json({ success: false, output, errors });
    }
});

// 1.6 Update Project
app.post('/ide-api/project/update', async (req, res) => {
    const { sessionId, changedFiles } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);

    if (!fs.existsSync(workspaceDir)) {
        return res.status(404).json({ error: 'Workspace expired. Please run a full sync.' });
    }

    try {
        if (changedFiles) {
            for (const [filePath, content] of Object.entries(changedFiles)) {
                // SECURITY: Ensure the file path doesn't escape the workspace directory
                const safeRelativePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
                const absolutePath = path.join(workspaceDir, safeRelativePath);

                fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                fs.writeFileSync(absolutePath, content as string);
            }
        }

        if (req.body.deletedPaths && Array.isArray(req.body.deletedPaths)) {
            for (const filePath of req.body.deletedPaths) {
                const safeRelativePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
                const absolutePath = path.join(workspaceDir, safeRelativePath);
                if (fs.existsSync(absolutePath)) {
                    fs.rmSync(absolutePath, { recursive: true, force: true });
                }
            }
        }

        console.log(`[CLI] Applied deltas for session ${sessionId}, running check...`);
        const { stdout, stderr } = await execPromise(`${CLARINET_CMD} check`, { cwd: workspaceDir });
        const output = (stdout || "") + (stderr || "");

        const now = new Date();
        fs.utimesSync(workspaceDir, now, now);

        res.json({ success: true, output, errors: [] });
    } catch (err: any) {
        let output = (err.stdout || "") + (err.stderr || "");
        const errLines = output.split('\n').filter((l: string) => l.includes('error:') || l.includes('syntax error'));
        const errors = errLines.length > 0 ? errLines : [err.message || "Update failed"];
        res.status(500).json({ success: false, output, errors });
    }
});

// 1.7 Clear Session (Delete Workspace)
app.post('/ide-api/project/session/clear', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);

    try {
        if (fs.existsSync(workspaceDir)) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
            console.log(`[CLI] Cleared workspace for session: ${sessionId}`);
        }
        res.json({ success: true, message: 'Session cleared' });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message || 'Clear failed' });
    }
});

// 1.8 Fetch Workspace Files (Sync from Server to IDE)
app.get('/ide-api/project/files/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);
    if (!fs.existsSync(workspaceDir)) {
        return res.status(404).json({ error: 'SERVER_WORKSPACE_EXPIRED', message: 'The server-side workspace has been cleared. Please click "Check/Compile" to re-initialize it.' });
    }

    try {
        const fileContents: Record<string, string> = {};

        const traverse = (dir: string, relativePath: string = '') => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relPath = relativePath ? path.join(relativePath, item).replace(/\\/g, '/') : item;

                // Skip node_modules, .git, and common build/cache dirs
                if (['node_modules', '.git', 'target', '.coverage'].includes(item)) continue;

                if (fs.statSync(fullPath).isDirectory()) {
                    traverse(fullPath, relPath);
                } else {
                    // Only read text-based source files for the IDE
                    if (/\.(clar|toml|md|txt|json|js|ts|tsx|yaml|yml|css|html)$/i.test(item)) {
                        fileContents[relPath] = fs.readFileSync(fullPath, 'utf8');
                    }
                }
            }
        };

        traverse(workspaceDir);
        res.json({ success: true, files: fileContents });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message || 'Failed to fetch files' });
    }
});

// 4. Execute Expression (Using clarinet console pipe)
app.post('/ide-api/clarity/execute', async (req, res) => {
    const { snippet, sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);
    if (!fs.existsSync(workspaceDir)) {
        return res.status(404).json({ error: 'Workspace expired. Please run a full sync.' });
    }

    try {
        // Include simple trace/assets collection
        const script = [...replHistory, snippet].join('\n') + '\n::get_assets\n';
        const scriptPath = path.join(workspaceDir, 'repl_input.clar');
        fs.writeFileSync(scriptPath, script);

        console.log(`[CLI] Executing snippet: ${snippet}`);

        const { stdout, stderr } = await execPromise(`${CLARINET_CMD} console < repl_input.clar`, { cwd: workspaceDir });
        const rawOutput = stdout + (stderr || "");
        const cleanCombined = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // Improved ANSI stripping
        const lines = cleanCombined.split('\n');

        let result = "Expression executed.";
        if (cleanCombined.includes('error:')) {
            const errorMatch = cleanCombined.match(/error: .+/g);
            result = errorMatch ? errorMatch[errorMatch.length - 1] : "Error occurred";
        } else {
            // Find the index of the prompt for the CURRENT snippet (search from end)
            const snippetPrompt = `>> ${snippet}`;
            let promptIdx = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].includes(snippetPrompt)) {
                    promptIdx = i;
                    break;
                }
            }

            if (promptIdx !== -1) {
                // Find where the next prompt or asset summary starts (end of our result block)
                let endIdx = lines.findIndex((l, idx) => idx > promptIdx && (l.includes('>>') || l.includes('Asset balance')));
                if (endIdx === -1) endIdx = lines.length;

                // Capture all lines in this command's response block
                const outputBlock = lines.slice(promptIdx + 1, endIdx)
                    .map(l => l.trim())
                    .filter(l => l &&
                        !l.startsWith('>>') &&
                        !l.includes('---') &&
                        !l.includes('===') &&
                        !l.startsWith('$') &&
                        !l.includes('clarinetrc.toml') &&
                        !l.includes('hints can be disabled') &&
                        !l.toLowerCase().startsWith('tip:') &&
                        !l.toLowerCase().startsWith('hint:'));

                result = outputBlock.join('\n') || "Success";
            } else {
                // Fallback: get the last non-boilerplate line
                const outputLines = lines.filter(l => {
                    const t = l.trim();
                    return t.length > 0 &&
                        !t.startsWith('>>') &&
                        !t.includes('Clarinet') &&
                        !t.includes('Asset balance') &&
                        !/^[-=]{3,}$/.test(t) &&
                        !t.startsWith('$') &&
                        !t.includes('clarinetrc.toml') &&
                        !t.includes('hints can be disabled') &&
                        !t.toLowerCase().startsWith('tip:') &&
                        !t.toLowerCase().startsWith('hint:') &&
                        !t.includes('Connected to');
                });
                result = outputLines[outputLines.length - 1] || "Success";
            }
        }

        if (!result.toLowerCase().includes('error')) {
            replHistory.push(snippet);
        }

        res.json({
            success: !result.toLowerCase().includes('error'),
            result: result,
            events: []
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Get State (Simulated via clarinet console)
app.post('/ide-api/clarity/state', async (req, res) => {
    const { contractName, sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);
    if (!fs.existsSync(workspaceDir)) {
        return res.status(404).json({ error: 'Workspace expired. Please run a full sync.' });
    }

    try {
        const script = '::get_assets\n';
        const scriptPath = path.join(workspaceDir, 'state_input.clar');
        fs.writeFileSync(scriptPath, script);

        const { stdout } = await execPromise(`${CLARINET_CMD} console < state_input.clar`, { cwd: workspaceDir });

        const lines = stdout.split('\n');
        const state: any[] = [];

        lines.forEach(line => {
            if (line.includes('Asset balance')) {
                const match = line.match(/Asset balance (.+): (.+)/);
                if (match) {
                    state.push({ name: match[1], type: 'asset', value: match[2] });
                }
            }
        });

        res.json({
            success: true,
            state,
            blockHeight: 1,
            deployer: DEPLOYER
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Terminal Execution (Generic clarinet command)
app.post('/ide-api/clarity/terminal', async (req, res) => {
    const { command, sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const workspaceDir = getWorkspacePath(sessionId);
    if (!fs.existsSync(workspaceDir)) {
        return res.status(404).json({ error: 'Workspace expired. Please run a full sync.' });
    }

    try {
        console.log(`[CLI] Terminal command: ${command}`);

        if (!command.trim().startsWith('clarinet')) {
            return res.json({ success: false, output: 'Only clarinet commands are allowed.' });
        }

        const finalCommand = command.replace(/^clarinet/, CLARINET_CMD);
        const { stdout, stderr } = await execPromise(finalCommand, { cwd: workspaceDir });
        res.json({
            success: true,
            output: stdout + (stderr || "")
        });
    } catch (error: any) {
        res.json({
            success: false,
            output: (error.stdout || "") + (error.stderr || "") || error.message
        });
    }
});


// --- Git API Routes ---

const REPO_ROOT = process.cwd();

app.get('/ide-api/git/status', async (req, res) => {
    try {
        const { stdout: statusOut } = await execPromise('git status --porcelain', { cwd: REPO_ROOT });
        const { stdout: branchOut } = await execPromise('git branch --show-current', { cwd: REPO_ROOT });

        const lines = statusOut.split('\n').filter(Boolean);
        const modifiedFiles: string[] = [];
        const stagedFiles: string[] = [];
        const untrackedFiles: string[] = [];

        lines.forEach(line => {
            const status = line.substring(0, 2);
            const file = line.substring(3).trim();

            if (status[0] !== ' ' && status[0] !== '?') {
                stagedFiles.push(file);
            }
            if (status[1] === 'M' || status[1] === 'D') {
                modifiedFiles.push(file);
            }
            if (status === '??') {
                untrackedFiles.push(file);
                modifiedFiles.push(file);
            }
        });

        res.json({
            success: true,
            branch: branchOut.trim(),
            modifiedFiles,
            stagedFiles,
            untrackedFiles
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/git/stage', async (req, res) => {
    const { filePath } = req.body;
    try {
        await execPromise(`git add "${filePath}"`, { cwd: REPO_ROOT });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/git/unstage', async (req, res) => {
    const { filePath } = req.body;
    try {
        await execPromise(`git restore --staged "${filePath}"`, { cwd: REPO_ROOT });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/git/discard', async (req, res) => {
    const { filePath } = req.body;
    try {
        await execPromise(`git restore "${filePath}"`, { cwd: REPO_ROOT });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/git/commit', async (req, res) => {
    const { message } = req.body;
    try {
        await execPromise(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: REPO_ROOT });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/ide-api/git/log', async (req, res) => {
    try {
        const { stdout } = await execPromise('git log -n 20 --pretty=format:"%H|%an|%at|%s|%D" --all', { cwd: REPO_ROOT });
        const commits = stdout.split('\n').filter(Boolean).map(line => {
            const [hash, author, date, message, refNames] = line.split('|');
            let branch = 'main';
            if (refNames) {
                const branchMatch = refNames.match(/-> ([\w/-]+)/) || refNames.match(/base\/([\w/-]+)/);
                if (branchMatch) branch = branchMatch[1];
                else if (refNames.includes('HEAD')) {
                    const parts = refNames.split(', ');
                    branch = parts[0].replace('HEAD -> ', '').trim();
                }
            }

            return {
                id: hash,
                hash: hash.substring(0, 7),
                author,
                date: parseInt(date) * 1000,
                message,
                branch: branch || 'main'
            };
        });
        res.json({ success: true, commits });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/ide-api/git/branches', async (req, res) => {
    try {
        const { stdout } = await execPromise('git branch --format="%(refname:short)"', { cwd: REPO_ROOT });
        const branches = stdout.split('\n').filter(Boolean);
        res.json({ success: true, branches });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/git/checkout', async (req, res) => {
    const { branch, create } = req.body;
    try {
        const cmd = create ? `git checkout -b "${branch}"` : `git checkout "${branch}"`;
        await execPromise(cmd, { cwd: REPO_ROOT });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- GitHub Auth Routes ---

app.get('/ide-api/auth/github', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'GitHub OAuth not configured' });

    let frontendUrl = process.env.FRONTEND_URL;

    // fallbacks if FRONTEND_URL is not set
    if (!frontendUrl) {
        if (req.headers['x-forwarded-host']) {
            const proto = req.headers['x-forwarded-proto'] || 'https';
            frontendUrl = `${proto}://${req.headers['x-forwarded-host']}`;
        } else if (req.headers.referer) {
            const url = new URL(req.headers.referer);
            frontendUrl = `${url.protocol}//${url.host}`;
        } else {
            frontendUrl = 'http://localhost:3000';
        }
    }

    // Sanitize: Remove trailing slash and any path components
    try {
        const url = new URL(frontendUrl);
        frontendUrl = `${url.protocol}//${url.host}`;
    } catch (e) {
        frontendUrl = frontendUrl.replace(/\/$/, '');
    }

    const redirectUri = `${frontendUrl}/ide-api/auth/github/callback`;
    console.log(`[Auth] Initiating GitHub login. Redirect URI: ${redirectUri}`);

    const scope = 'read:user user:email repo gist';
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
    res.redirect(githubAuthUrl);
});

app.get('/ide-api/auth/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.redirect('/?error=oauth_not_configured');

    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.error) return res.redirect('/?error=' + tokenData.error);

        const accessToken = tokenData.access_token;
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/vnd.github.v3+json' }
        });

        const userData = await userResponse.json();
        const cookieValue = JSON.stringify({
            token: accessToken,
            user: { login: userData.login, avatar_url: userData.avatar_url, name: userData.name, id: userData.id }
        });

        const encodedCookie = Buffer.from(cookieValue).toString('base64');
        res.setHeader('Set-Cookie', `github_auth=${encodedCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(frontendUrl);
    } catch (error) {
        console.error('GitHub OAuth error:', error);
        res.redirect('/?error=oauth_failed');
    }
});

app.get('/ide-api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'github_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(frontendUrl);
});

// --- GitHub API Proxy Routes ---

app.get('/ide-api/github/user', (req, res) => {
    const authCookie = req.cookies?.github_auth;
    if (!authCookie) return res.json({ authenticated: false });
    try {
        const decoded = Buffer.from(authCookie, 'base64').toString('utf-8');
        const authData = JSON.parse(decoded);
        res.json({ authenticated: true, user: authData.user });
    } catch (error) {
        res.json({ authenticated: false });
    }
});

app.get('/ide-api/github/repos', async (req, res) => {
    const authCookie = req.cookies?.github_auth;
    if (!authCookie) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const decoded = Buffer.from(authCookie, 'base64').toString('utf-8');
        const authData = JSON.parse(decoded);
        const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50', {
            headers: { 'Authorization': `Bearer ${authData.token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        const repos = await response.json();
        res.json({
            repos: Array.isArray(repos) ? repos.map((r: any) => ({
                id: r.id, name: r.name, full_name: r.full_name, description: r.description,
                html_url: r.html_url, clone_url: r.clone_url, private: r.private, language: r.language
            })) : []
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch repositories' });
    }
});

app.post('/ide-api/github/clone', async (req, res) => {
    const authCookie = req.cookies?.github_auth;
    let token = '';

    if (authCookie) {
        try {
            const decoded = Buffer.from(authCookie, 'base64').toString('utf-8');
            const authData = JSON.parse(decoded);
            token = authData.token;
        } catch (e) { }
    }

    try {
        const { owner, repo, branch = 'main' } = req.body;
        const headers: any = { 'Accept': 'application/vnd.github.v3+json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
        let treeResponse = await fetch(treeUrl, { headers });

        if (!treeResponse.ok && branch === 'main') {
            treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`;
            treeResponse = await fetch(treeUrl, { headers });
        }

        if (!treeResponse.ok) {
            const err = await treeResponse.json();
            throw new Error(err.message || 'Failed to fetch repository tree. Is it public?');
        }

        const tree = await treeResponse.json();
        const files = (tree.tree as any[]).filter(item => item.type === 'blob');
        const fileContents: Record<string, string> = {};

        const fileBatch = files.slice(0, 50);
        await Promise.all(fileBatch.map(async (file: any) => {
            if (file.size > 500000) return;
            if (/\.(png|jpg|jpeg|gif|ico|pdf|zip|tar|gz|woff|woff2|ttf|eot)$/i.test(file.path)) return;

            try {
                const blobRes = await fetch(file.url, { headers });
                if (blobRes.ok) {
                    const blob: any = await blobRes.json();
                    fileContents[file.path] = Buffer.from(blob.content, 'base64').toString('utf-8');
                }
            } catch (e) {
                console.warn(`Failed to fetch ${file.path}`);
            }
        }));

        res.json({ success: true, files: fileContents });
    } catch (error: any) {
        console.error('Clone error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/ide-api/github/gist', async (req, res) => {
    const authCookie = req.cookies?.github_auth;
    if (!authCookie) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const decoded = Buffer.from(authCookie, 'base64').toString('utf-8');
        const authData = JSON.parse(decoded);
        const { description, files, isPublic } = req.body;

        const gistFiles: any = {};
        for (const [name, content] of Object.entries(files)) {
            const safeName = (name as string).replace(/\//g, '_');
            gistFiles[safeName] = { content };
        }

        const response = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authData.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ description: description || 'Created with LabSTX IDE', public: isPublic, files: gistFiles })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || 'Failed to create gist');
        }

        const gist = await response.json();
        res.json({ success: true, url: gist.html_url });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

setInterval(() => {
    const tmpDir = os.tmpdir();
    fs.readdir(tmpDir, (err, files) => {
        if (err) return console.error('Sweeper error reading temp dir:', err);

        const now = Date.now();

        files.forEach(file => {
            if (file.startsWith(WORKSPACE_PREFIX)) {
                const fullPath = path.join(tmpDir, file);

                fs.stat(fullPath, (err, stats) => {
                    if (err) return;

                    if (now - stats.mtimeMs > MAX_IDLE_TIME_MS) {
                        fs.rm(fullPath, { recursive: true, force: true }, (err) => {
                            if (!err) console.log(`[Sweeper] Cleaned up idle workspace: ${file}`);
                        });
                    }
                });
            }
        });
    });
}, 5 * 60 * 1000); // Run the sweeper every 5 minutes

app.listen(PORT, () => {
    console.log(`\x1b[32m🚀 Clarinet CLI Backend running at http://localhost:${PORT}\x1b[0m`);
});
