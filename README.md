# ReachInbox — Email Scheduler

A full-stack email scheduling application that lets users compose email campaigns, upload leads, schedule deliveries, and monitor email status from a dashboard.

## Features

- **Guest login:** Local full-stack workspace and separate public simulation. No Google credentials needed.
- **Email scheduling:** Schedule emails for a future time using BullMQ and Redis delayed jobs.
- **Email sending:** Process scheduled jobs using a dedicated worker and SMTP.
- **Lead uploads:** Import email addresses from CSV and TXT files.
- **Attachments:** Upload supported image, PDF, and Word document attachments.
- **Rate limiting:** Enforce per-sender hourly limits and minimum intervals between sends.
- **Deferred jobs:** Reschedule jobs when the hourly limit is reached instead of discarding them.
- **Slack notifications:** Connect Slack and send notifications when a rate limit is reached.
- **Email dashboard:** View scheduled, queued, sending, sent, and failed emails.
- **Queue monitoring:** Inspect BullMQ queues through Bull Board.
- **Persistence:** Store email records in PostgreSQL and use Redis for job queue state.
- **Email search:** Integrate Elasticsearch for email search.

## Technology Stack

**Frontend**
- React
- TypeScript
- Vite
- CSS and Tailwind utility classes

**Backend**
- Node.js
- Express
- TypeScript
- PostgreSQL
- Redis
- BullMQ
- Elasticsearch
- SMTP via Ethereal Email
- Slack OAuth and notifications

## Architecture

1. The React frontend sends scheduling requests to the Express API.
2. The backend validates requests and stores email job records in PostgreSQL.
3. BullMQ places jobs in Redis with their scheduled execution times.
4. A separate worker processes jobs, applying sender limits and minimum send intervals.
5. Emails are delivered through the configured SMTP transport.
6. Email status updates are stored in PostgreSQL and displayed in the dashboard.
7. When a rate limit is reached, jobs are deferred and Slack notifications are sent.
8. Elasticsearch supports email search, while Bull Board provides queue monitoring.

## Prerequisites

Install the following before running the project:

- Node.js and npm
- PostgreSQL
- Redis
- Elasticsearch

Use Docker Desktop and run `docker compose up -d` from the root. Copy `backend/.env.example` to `backend/.env` and fill SMTP_USER and SMTP_PASS with test credentials from https://ethereal.email/. Never commit .env. Slack is optional; configure its original environment variables if testing Slack.

## Installation

From the project root:

```powershell
npm install
```

Install backend dependencies:

```powershell
cd backend
npm install
```

Initialize the database using the project's database initialization script, following the configured PostgreSQL connection settings.

## Running the Application

Start each service in a separate terminal.

### Terminal 1 — Backend API

```powershell
cd backend
npm run dev
```

Expected local API address:

`http://localhost:3000`

### Terminal 2 — Email Worker

```powershell
cd backend
npm run worker
```

Keep the worker running to process email jobs.

### Terminal 3 — Frontend

From the project root:

```powershell
npm run dev
```

Open the Vite URL shown in the terminal, typically:

`http://localhost:5174`

### Queue Dashboard

Open:

`http://localhost:3000/admin/queues`

Do not expose this administrative dashboard publicly without appropriate authentication and access controls.

## Build and Verification

Build the frontend and run TypeScript checks:

```powershell
npm run build
```

## Demo Checklist

The demonstration video should be no longer than five minutes and show:

1. Guest login and the user profile.
2. The email dashboard and compose form.
3. Uploading a small CSV or TXT leads file.
4. Scheduling an email with a future execution time.
5. The email progressing through the queue and its resulting status.
6. Restarting the worker or application and showing that scheduled jobs persist.
7. The configured hourly limit and minimum send interval.
8. A rate-limit event, job rescheduling, and the corresponding Slack notification.

Use a controlled test recipient and test credentials. Do not show secrets, private tokens, or personal data in the recording.

## Security Notes

- Keep environment files and credentials out of version control.
- Guest login is not authentication; keep the backend local.
- Configure authentication and authorization before exposing protected operations or the queue dashboard publicly.
- Use test email accounts and follow applicable email-sending rules.

## Project Status

Localhost uses the restored API-backed frontend. Remote hosts (including Vercel) use the separate browser-only simulation, with no backend requests. Set VITE_PUBLIC_DEMO=true locally if you want to preview that simulation. The local backend binds to loopback; do not expose it publicly until real authentication, authorization and abuse controls are implemented.

After starting the API, create a sender using PowerShell (replace the email with your Ethereal SMTP username):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/senders -ContentType 'application/json' -Body (@{name='Test Sender'; email='YOUR_ETHEREAL_USERNAME'; hourlyLimit=20; minIntervalSeconds=60} | ConvertTo-Json)
```

Start the worker and frontend as described above. Test only with Ethereal. End-to-end verification requires running the services.
