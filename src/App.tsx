
import { GoogleLogin, googleLogout } from '@react-oauth/google'
import type { CredentialResponse } from '@react-oauth/google'
import { useCallback, useEffect, useState } from 'react'
import './App.css'

const API = `${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/api`
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 5

type EmailStatus = 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed'

type Email = {
  id: string
  recipient_email: string
  subject: string
  scheduled_at: string
  sent_at: string | null
  status: EmailStatus
  error_message?: string | null
}

type Sender = {
  id: number
  name: string
  email: string
  hourly_limit: number
  min_interval_seconds: number
}

type UploadedAttachment = {
  originalName: string
  storedName: string
  filePath: string
  mimeType: string
  fileSize: number
}

type GoogleUser = {
  id: string
  name: string
  email: string
  picture: string | null
}

function App() {
  const [activeTab, setActiveTab] = useState<'Scheduled' | 'Sent'>('Scheduled')
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [body, setBody] = useState('')
  const [startTime, setStartTime] = useState('')
  const [delay, setDelay] = useState(10)
  const [senderId, setSenderId] = useState('')
  const [leads, setLeads] = useState<string[]>([])
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [uploadingAttachments, setUploadingAttachments] = useState(false)
  const [emails, setEmails] = useState<Email[]>([])
  const [senders, setSenders] = useState<Sender[]>([])
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null)
  const [googleLoginError, setGoogleLoginError] = useState('')
  const [googleLoginLoading, setGoogleLoginLoading] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [emailResponse, senderResponse] = await Promise.all([
        fetch(`${API}/emails`),
        fetch(`${API}/senders`),
      ])

      if (!emailResponse.ok || !senderResponse.ok) {
        throw new Error('Could not load dashboard data.')
      }

      const emailData: Email[] = await emailResponse.json()
      const senderData: Sender[] = await senderResponse.json()

      setEmails(emailData)
      setSenders(senderData)

      if (senderData.length > 0) {
        setSenderId(current => current || String(senderData[0].id))
      }

      setMessage(current =>
        current.includes('Make sure the backend is running.') ? '' : current
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `${error.message} Make sure the backend is running.`
          : 'Could not connect to the backend.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function handleGoogleLogin(response: CredentialResponse) {
    if (!response.credential) {
      setGoogleLoginError('Google did not return a sign-in credential.')
      return
    }

    setGoogleLoginLoading(true)
    setGoogleLoginError('')

    try {
      const result = await fetch(`${API}/auth/google/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      })

      const data = await result.json()

      if (!result.ok || !data.user) {
        throw new Error(data.message || 'Google sign-in failed.')
      }

      const user = data.user as GoogleUser
      setGoogleUser(user)
    } catch (error) {
      setGoogleLoginError(
        error instanceof Error ? error.message : 'Google sign-in failed.'
      )
    } finally {
      setGoogleLoginLoading(false)
    }
  }

  function handleGoogleLogout() {
    googleLogout()
    setGoogleUser(null)
    setGoogleLoginError('')
  }

  function parseFile(file?: File) {
    if (!file) return

    const reader = new FileReader()

    reader.onload = () => {
      const text = String(reader.result || '')
      const found =
        text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []

      const uniqueEmails = [
        ...new Set(found.map(email => email.toLowerCase())),
      ]

      setLeads(uniqueEmails)
      setMessage(
        uniqueEmails.length
          ? `Found ${uniqueEmails.length} unique email addresses.`
          : 'No email addresses were found in that file.'
      )
    }

    reader.onerror = () => {
      setMessage('Could not read the selected leads file.')
    }

    reader.readAsText(file)
  }

  function handleAttachmentSelection(files: FileList | null) {
    if (!files) return

    const selected = Array.from(files)

    if (selected.length > MAX_FILES) {
      setMessage(`Choose no more than ${MAX_FILES} attachments.`)
      setAttachmentFiles([])
      return
    }

    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx)$/i

    for (const file of selected) {
      if (!allowedExtensions.test(file.name)) {
        setMessage(
          `${file.name} is not supported. Choose images, PDFs, or Word documents.`
        )
        setAttachmentFiles([])
        return
      }

      if (file.size > MAX_FILE_SIZE) {
        setMessage(`${file.name} exceeds the 10 MB per-file limit.`)
        setAttachmentFiles([])
        return
      }

      if (file.size === 0) {
        setMessage(`${file.name} is empty. Please choose another file.`)
        setAttachmentFiles([])
        return
      }
    }

    setAttachmentFiles(selected)
    setMessage(
      selected.length
        ? `${selected.length} attachment(s) selected.`
        : ''
    )
  }

  async function uploadAttachments(): Promise<UploadedAttachment[]> {
    if (attachmentFiles.length === 0) return []

    setUploadingAttachments(true)

    try {
      const formData = new FormData()

      attachmentFiles.forEach(file => {
        formData.append('attachments', file)
      })

      const response = await fetch(`${API}/attachments/upload`, {
        method: 'POST',
        body: formData,
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.message || 'Attachment upload failed.')
      }

      if (!Array.isArray(result.files)) {
        throw new Error('The server returned an unexpected upload response.')
      }

      return result.files as UploadedAttachment[]
    } finally {
      setUploadingAttachments(false)
    }
  }

  function getRecipients(): string[] | null {
    const manualEmail = recipientEmail.trim().toLowerCase()

    const recipients =
      leads.length > 0
        ? leads
        : manualEmail
          ? [manualEmail]
          : []

    if (!subject.trim() || !body.trim() || recipients.length === 0) {
      setMessage(
        'Enter a recipient email or upload a leads file, along with a subject and email body.'
      )
      return null
    }

    if (
      leads.length === 0 &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(manualEmail)
    ) {
      setMessage('Enter a valid recipient email address.')
      return null
    }

    if (!senderId) {
      setMessage('Select a sender before continuing.')
      return null
    }

    return recipients
  }

  function clearCompose() {
    setSubject('')
    setRecipientEmail('')
    setBody('')
    setStartTime('')
    setLeads([])
    setAttachmentFiles([])
  }

  async function scheduleEmails() {
    setMessage('')

    const recipients = getRecipients()
    if (!recipients) return

    if (!startTime) {
      setMessage('Choose a future start time for your scheduled emails.')
      return
    }

    const start = new Date(startTime)

    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
      setMessage('Choose a start time in the future.')
      return
    }

    setSubmitting(true)
    let succeeded = 0
    const errors: string[] = []

    try {
      let uploadedAttachments: UploadedAttachment[]

      try {
        uploadedAttachments = await uploadAttachments()
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Could not upload attachments.'
        )
        return
      }

      for (let index = 0; index < recipients.length; index++) {
        const scheduledAt = new Date(
          start.getTime() + index * Math.max(1, delay) * 1000
        )

        try {
          const response = await fetch(`${API}/emails/schedule`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': crypto.randomUUID(),
            },
            body: JSON.stringify({
              senderId: Number(senderId),
              recipientEmail: recipients[index],
              subject: subject.trim(),
              body: body.trim(),
              scheduledAt: scheduledAt.toISOString(),
              attachments: uploadedAttachments,
            }),
          })

          const result = await response.json()

          if (!response.ok) {
            throw new Error(result.message || 'Scheduling failed.')
          }

          succeeded++
        } catch (error) {
          errors.push(
            `${recipients[index]}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          )
        }
      }

      await loadData()

      if (errors.length === 0) {
        setMessage(`Successfully scheduled ${succeeded} email(s).`)
        setShowCompose(false)
        clearCompose()
        setActiveTab('Scheduled')
      } else {
        setMessage(
          `Scheduled ${succeeded} of ${recipients.length} emails. ` +
            `Errors: ${errors.slice(0, 3).join(' | ')}`
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function sendEmailsNow() {
    setMessage('')

    const recipients = getRecipients()
    if (!recipients) return

    setSubmitting(true)
    let succeeded = 0
    const errors: string[] = []

    try {
      let uploadedAttachments: UploadedAttachment[]

      try {
        uploadedAttachments = await uploadAttachments()
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Could not upload attachments.'
        )
        return
      }

      for (const recipient of recipients) {
        try {
          const response = await fetch(`${API}/emails/send-now`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': crypto.randomUUID(),
            },
            body: JSON.stringify({
              senderId: Number(senderId),
              recipientEmail: recipient,
              subject: subject.trim(),
              body: body.trim(),
              attachments: uploadedAttachments,
            }),
          })

          const result = await response.json()

          if (!response.ok) {
            throw new Error(result.message || 'Could not queue email.')
          }

          succeeded++
        } catch (error) {
          errors.push(
            `${recipient}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          )
        }
      }

      await loadData()

      if (errors.length === 0) {
        setMessage(
          `Queued ${succeeded} email(s) for immediate sending. Check their status in the dashboard.`
        )
        setShowCompose(false)
        clearCompose()
        setActiveTab('Scheduled')
      } else {
        setMessage(
          `Queued ${succeeded} of ${recipients.length} emails. ` +
            `Errors: ${errors.slice(0, 3).join(' | ')}`
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  const selectedSender = senders.find(
    sender => String(sender.id) === senderId
  )

  const scheduledEmails = emails.filter(email =>
    ['scheduled', 'queued', 'sending'].includes(email.status)
  )

  const completedEmails = emails.filter(email =>
    ['sent', 'failed'].includes(email.status)
  )

  const visibleEmails =
    activeTab === 'Scheduled' ? scheduledEmails : completedEmails

  const totalSent = emails.filter(email => email.status === 'sent').length
  const failedCount = emails.filter(email => email.status === 'failed').length

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-700/70 bg-[#111827] shadow-lg shadow-black/10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-lg font-extrabold text-white shadow-lg shadow-violet-900/40">
              R
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">
                ReachInbox
              </h1>
              <p className="text-xs text-slate-400">Email Scheduler</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void loadData()}
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-violet-500 hover:bg-slate-700"
            >
              ↻ Refresh data
            </button>

            {googleUser ? (
              <div className="flex flex-wrap items-center gap-3">
                {googleUser.picture && (
                  <img
                    src={googleUser.picture}
                    alt="Google profile"
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 rounded-full border border-slate-600 object-cover"
                  />
                )}

                <div className="hidden sm:block">
                  <p className="text-sm font-semibold text-white">
                    {googleUser.name}
                  </p>
                  <p className="text-xs text-slate-400">{googleUser.email}</p>
                </div>

                <button
                  onClick={handleGoogleLogout}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
                >
                  Logout
                </button>
              </div>
            ) : (
              <GoogleLogin
                onSuccess={(response) => void handleGoogleLogin(response)}
                onError={() =>
                  setGoogleLoginError('Google sign-in was unsuccessful.')
                }
                useOneTap={false}
              />
            )}
          </div>
        </div>

        {googleLoginLoading && (
          <p className="mx-auto max-w-7xl px-6 pb-3 text-sm text-violet-300">
            Verifying Google sign-in...
          </p>
        )}

        {googleLoginError && (
          <p
            role="alert"
            className="mx-auto max-w-7xl px-6 pb-3 text-sm text-rose-300"
          >
            {googleLoginError}
          </p>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-violet-400">
              Campaign workspace
            </p>
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Email campaigns
            </h2>
            <p className="mt-2 text-slate-400">
              Schedule, manage and track your email outreach.
            </p>
          </div>

          <button
            onClick={() => {
              setMessage('')
              setShowCompose(true)
            }}
            className="rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 font-semibold text-white shadow-lg shadow-violet-950/40 transition hover:-translate-y-0.5 hover:from-violet-500 hover:to-indigo-500"
          >
            + Compose New Email
          </button>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Total emails" value={emails.length} accent="violet" />
          <Stat
            label="Scheduled / Pending"
            value={scheduledEmails.length}
            accent="blue"
          />
          <Stat label="Sent successfully" value={totalSent} accent="emerald" />
          <Stat label="Failed emails" value={failedCount} accent="rose" />
        </div>

        {message && !showCompose && (
          <div className="mt-5 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4 text-sm text-violet-200">
            {message}
          </div>
        )}

        <section className="mt-8 overflow-hidden rounded-2xl border border-slate-700/80 bg-[#111827] shadow-2xl shadow-black/20">
          <div className="flex gap-6 border-b border-slate-700 px-6">
            {(['Scheduled', 'Sent'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`border-b-2 px-1 py-4 text-sm font-semibold transition ${
                  activeTab === tab
                    ? 'border-violet-400 text-violet-300'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                {tab === 'Sent' ? 'Sent / Failed' : 'Scheduled'} Emails
              </button>
            ))}
          </div>

          {loading ? (
            <div className="px-6 py-20 text-center text-slate-400">
              Loading emails from backend...
            </div>
          ) : visibleEmails.length === 0 ? (
            <div className="px-6 py-20 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10 text-2xl text-violet-300">
                ✉
              </div>
              <h3 className="mt-4 font-semibold text-white">
                No {activeTab.toLowerCase()} emails yet
              </h3>
              <p className="mt-2 text-sm text-slate-400">
                Your backend email records will appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/80 text-xs uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-6 py-4 font-medium">Recipient</th>
                    <th className="px-6 py-4 font-medium">Subject</th>
                    <th className="px-6 py-4 font-medium">Scheduled time</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {visibleEmails.map(email => (
                    <tr
                      key={email.id}
                      className="transition-colors hover:bg-violet-500/5"
                    >
                      <td className="px-6 py-4">{email.recipient_email}</td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-100">
                          {email.subject}
                        </div>
                        {email.error_message && (
                          <p className="mt-1 text-xs text-rose-400">
                            {email.error_message}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-400">
                        {new Date(email.scheduled_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={email.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {showCompose && (
        <div className="fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
          <div className="my-auto w-full max-w-xl rounded-2xl border border-slate-700 bg-[#111827] p-6 text-slate-100 shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-violet-400">
                  New campaign
                </p>
                <h2 className="mt-1 text-xl font-bold text-white">
                  Compose email
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowCompose(false)}
                className="rounded-lg px-3 py-1 text-2xl text-slate-400 transition hover:bg-slate-800 hover:text-white"
                aria-label="Close compose dialog"
              >
                ×
              </button>
            </div>

            <label className="mt-5 block text-sm font-medium text-slate-300">
              Sender
            </label>
            <select
              value={senderId}
              onChange={event => setSenderId(event.target.value)}
              className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
            >
              <option value="">Select a sender</option>
              {senders.map(sender => (
                <option key={sender.id} value={sender.id}>
                  {sender.name} ({sender.email})
                </option>
              ))}
            </select>

            {selectedSender && (
              <p className="mt-2 text-xs text-slate-400">
                Limit: {selectedSender.hourly_limit} emails/hour · Minimum
                interval: {selectedSender.min_interval_seconds} seconds
              </p>
            )}

            <label className="mt-5 block text-sm font-medium text-slate-300">
              Recipient email (optional if uploading leads)
            </label>
            <input
              type="email"
              value={recipientEmail}
              onChange={event => setRecipientEmail(event.target.value)}
              className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
              placeholder="recipient@example.com"
            />

            <label className="mt-5 block text-sm font-medium text-slate-300">
              Subject
            </label>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
              placeholder="Your email subject"
            />

            <label className="mt-4 block text-sm font-medium text-slate-300">
              Email body
            </label>
            <textarea
              value={body}
              onChange={event => setBody(event.target.value)}
              rows={4}
              className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
              placeholder="Write your message..."
            />

            <label className="mt-4 block text-sm font-medium text-slate-300">
              Upload leads (.csv or .txt)
            </label>
            <input
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              onChange={event => parseFile(event.target.files?.[0])}
              className="dark-field mt-2 block w-full rounded-lg border border-slate-700 p-3 text-sm"
            />
            <p className="mt-2 text-sm text-slate-400">
              {leads.length} unique email addresses detected
            </p>

            <label className="mt-4 block text-sm font-medium text-slate-300">
              Attach files (images, PDF, Word)
            </label>
            <input
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={event =>
                handleAttachmentSelection(event.target.files)
              }
              className="dark-field mt-2 block w-full rounded-lg border border-slate-700 p-3 text-sm"
            />
            <p className="mt-2 text-xs text-slate-400">
              Maximum 5 files, 10 MB each.
            </p>

            {attachmentFiles.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
                <p className="mb-2 text-sm font-medium text-slate-200">
                  Selected attachments ({attachmentFiles.length})
                </p>
                <ul className="space-y-2">
                  {attachmentFiles.map((file, index) => (
                    <li
                      key={`${file.name}-${file.size}-${index}`}
                      className="flex items-center justify-between gap-3 text-sm text-slate-300"
                    >
                      <span className="min-w-0 break-all">{file.name}</span>
                      <span className="shrink-0 text-xs text-slate-500">
                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => {
                    setAttachmentFiles([])
                    setMessage('')
                  }}
                  className="mt-3 text-xs font-medium text-rose-300 hover:text-rose-200"
                >
                  Remove all attachments
                </button>
              </div>
            )}

            <label className="mt-4 block text-sm font-medium text-slate-300">
              Start time (required for scheduling)
            </label>
            <input
              type="datetime-local"
              min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
              value={startTime}
              onChange={event => setStartTime(event.target.value)}
              className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
            />

            <div className="mt-4">
              <label className="block text-sm font-medium text-slate-300">
                Delay between scheduled emails (seconds)
              </label>
              <input
                type="number"
                min={1}
                value={delay}
                onChange={event =>
                  setDelay(Math.max(1, Number(event.target.value)))
                }
                className="dark-field mt-2 w-full rounded-lg border border-slate-700 px-3 py-2.5"
              />
            </div>

            <p className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/10 p-3 text-xs leading-5 text-violet-200">
              Send Now queues emails for immediate processing. Scheduling
              uses your selected start time and delay. Selected attachments
              will be included with each recipient's email. Actual sending
              depends on your backend worker and sender rate limits.
            </p>

            {message && (
              <p
                role="alert"
                className="mt-3 whitespace-pre-wrap text-sm text-rose-400"
              >
                {message}
              </p>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCompose(false)}
                disabled={submitting}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => void scheduleEmails()}
                disabled={submitting || uploadingAttachments}
                className="rounded-lg border border-violet-500/60 px-4 py-2 text-sm font-semibold text-violet-300 transition hover:bg-violet-500/10 disabled:opacity-50"
              >
                {uploadingAttachments
                  ? 'Uploading files...'
                  : submitting
                    ? 'Processing...'
                    : 'Schedule emails'}
              </button>

              <button
                type="button"
                onClick={() => void sendEmailsNow()}
                disabled={submitting || uploadingAttachments}
                className="rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-950/30 transition hover:from-violet-500 hover:to-indigo-500 disabled:opacity-50"
              >
                {uploadingAttachments
                  ? 'Uploading files...'
                  : submitting
                    ? 'Processing...'
                    : 'Send Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent: 'violet' | 'blue' | 'emerald' | 'rose'
}) {
  const accents = {
    violet: 'before:bg-violet-500',
    blue: 'before:bg-blue-500',
    emerald: 'before:bg-emerald-500',
    rose: 'before:bg-rose-500',
  }

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-slate-700/80 bg-[#111827] p-6 shadow-xl shadow-black/10 transition duration-200 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accents[accent]} hover:-translate-y-1 hover:border-slate-600 hover:shadow-2xl`}
    >
      <p className="text-sm font-medium text-slate-400">{label}</p>
      <p className="mt-3 text-4xl font-extrabold tracking-tight text-white">
        {value}
      </p>
      <p className="mt-3 text-xs text-slate-500">Live dashboard count</p>
    </div>
  )
}

function StatusBadge({ status }: { status: EmailStatus }) {
  const styles: Record<EmailStatus, string> = {
    scheduled: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    queued: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    sending: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    sent: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    failed: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  }

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold capitalize ${styles[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  )
}

export default App
