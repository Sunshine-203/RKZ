# RKZ ركز

**When plans break, focus starts here.**

RKZ is an AI-assisted study web app for university students in Kuwait. It turns assignments and available study time into a realistic plan, gives each subject its own focus space, and helps students recover when a session doesn't go as planned.

## Features
1. **Study Planner + AI Study Steps**: AI turns an assignment description into editable, timed steps; RKZ schedules them into your daily study time and flags work that won't fit.
2. **Focus Room with Editable Subject Channels**: each subject (Math, Biology…) saves its own background, sound and focus length; timer with start/pause/resume/end; outcome saved as complete, partial or missed.
3. **Progress Review + AI Recovery**: AI reads your session note and the unfinished work, suggests concrete recovery steps; RKZ keeps finished work, reschedules the rest, flags what won't fit, and saves a before/after revision.

## Tech
| Part | Choice |
|---|---|
| Frontend | HTML, CSS, JavaScript (no framework, mobile-first) |
| Backend | Node.js + Express |
| Database | PostgreSQL (plans persist after refresh) |
| AI | OpenRouter → Google Gemini Flash, called **only from the server** |
| Hosting | Render (Blueprint in `render.yaml`) |
| Media | Scene photos provided by the team; ambient sounds generated live with the Web Audio API (100% original); Manrope font (OFL) |

## How the AI works
- `POST /api/ai/recovery`: the server sends the session note, the unfinished step and the deadline to the model and gets 1–3 recovery steps, a short message and a tip; output is validated and capped to the real remaining time.
- `POST /api/ai/suggest-steps`: the server sends the assignment name, subject, description and deadline to OpenRouter and asks for JSON steps.
- The server **validates** the AI output (titles cleaned, minutes rounded and clamped to 5–480) before the browser sees it.
- The student edits or accepts the steps, then RKZ's **own scheduler** (`src/scheduler.js`) places them into the available time. If AI is down, students add steps manually and planning still works.
- `OPENROUTER_API_KEY` is a server environment variable. It is never in the browser, the code or this repo.

## Security
- Optional accounts: sign up / log in with passwords hashed using scrypt + salt; login errors are always the generic "Incorrect username or password."; login attempts are rate-limited.
- Guests need no login: each browser gets a random private id in an HttpOnly cookie, and every database query is filtered by it. Signing up keeps the guest's plans.
- All input is validated on the server (`src/validate.js`), plus request size limits, a per-user AI rate limit and strict security headers (CSP).

## Run locally
```bash
npm install
DATABASE_URL=postgres://... OPENROUTER_API_KEY=... npm start
# tests (needs a test database)
TEST_DATABASE_URL=postgres://... npm test
```

## Built with Claude
We used Claude (Anthropic) as our AI coding assistant during the hackathon: to sharpen the idea, PRD and judge test steps; to write and review the backend, scheduler, validation and frontend stage by stage; to write automated tests (scheduler + API against real PostgreSQL); and to guide deployment on Render. The team made the product decisions, the logo, brand and story, and tested every feature on the live link.
