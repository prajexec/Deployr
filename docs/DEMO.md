# Demo Recording Guide (GIF Walkthrough)

This guide provides a timed, step-by-step script for recording a clean 30–45 second demo GIF of DeployService.

---

## Preparation (Pre-recording)

1. **Terminal 1 (Backend Services)**:
   Ensure all containers are running and healthy:
   ```bash
   docker compose up -d
   ```
2. **Terminal 2 (Retrieve API Key)**:
   ```bash
   grep API_KEY .env | cut -d '=' -f2 | pbcopy
   # API_KEY is now in your clipboard!
   ```
3. **Browser**:
   - Open Chrome/Arc and navigate to `http://localhost:5173`.
   - Set browser zoom to 100% or 110% for crisp text readability.
   - Position screen recording software (e.g., CleanShot X, Kap, or QuickTime) over the dashboard window (recommended size: `1280x800`).

---

## Timed Recording Script (40 Seconds Total)

### Act 1: Authentication & Deployment Submission (00:00 – 00:08)

- **Action**: Paste your `API_KEY` into the top bar's **API Key** input.
- **Action**: In the "Deploy New Repository" form, paste:
  ```
  https://github.com/octocat/Spoon-Knife
  ```
- **Action**: Click the purple **Deploy** button.

### Act 2: Real-time Live Log Streaming (00:08 – 00:20)

- **Visual**: The UI immediately transitions to the **Build Console** detail view.
- **Visual**: Show live stream logs updating in real time:
  ```
  [builder] DeployService Container Sandbox Entrypoint started.
  [builder] Cloning repository: https://github.com/octocat/Spoon-Knife
  [builder] Cloned commit: d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9
  [builder] Detected framework: static (output: .)
  [builder] Build completed successfully. Staged artifacts in /build/output.
  ```
- **Visual**: Status badge transitions from `BUILDING` to green `DEPLOYED`.

### Act 3: Live Preview & Production Site (00:20 – 00:28)

- **Action**: Click the green **Preview URL ↗** button.
- **Visual**: A new tab opens showing `http://<deploymentId>.localhost:8080` displaying the rendered Spoon-Knife page.
- **Action**: Switch back to the dashboard tab.

### Act 4: Deployments Table & Atomic Rollback (00:28 – 00:35)

- **Action**: Click **← Back to All Deployments**.
- **Visual**: The recent deployments table displays all past builds with commit hashes, timestamps, and status badges.
- **Action**: Click the purple **Rollback** button next to a previous deployment.
- **Visual**: Green confirmation notification appears: `Project prj_... rolled back to deployment d-...`.

### Act 5: Real-time Cancellation (00:35 – 00:42)

- **Action**: Submit a new build (`https://github.com/facebook/react`).
- **Action**: Immediately click the red **Cancel** button.
- **Visual**: Status badge flips to `CANCELLED` and terminal logs report exit code 130 (`Deployment cancelled by user`).

---

## Exporting Tips

- **Framerate**: 20–30 FPS is optimal for smooth terminal scrolling.
- **Colors**: Use dark mode (default in DeployService UI).
- **Save Path**: Export the final GIF to `docs/assets/demo.gif`.
