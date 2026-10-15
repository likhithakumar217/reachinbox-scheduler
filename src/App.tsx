
import { useCallback, useEffect, useState } from 'react'
import './App.css'

const API = 'http://localhost:3000/api'

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

function App() {
  const [activeTab, setActiveTab] = useState<'Scheduled' | 'Sent'>('Scheduled')
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [startTime, setStartTime] = useState('')
  const [delay, setDelay] = useState(10)
  const [senderId, setSenderId] = useState('')
  const [leads, setLeads] = useState<string[]>([])
  const [emails, setEmails] = useState<Email[]>([])
  const [senders, setSenders] = useState<Sender[]>([])
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

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
        setSenderId(current =>
          current || String(senderData[0].id)
        )
      }
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

  function parseFile(file?: File) {
    if (!file) return

    const reader = new FileReader()

    reader.onload = () => {
      const text = String(reader.result || '')
      const found =
        text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []

      setLeads([...new Set(found.map(email => email.toLowerCase()))])
      setMessage('')
    }

    reader.onerror = () => {
      setMessage('Could not read the selected file.')
    }

    reader.readAsText(file)
  }

  async function scheduleEmails() {
    setMessage('')

    if (!subject.trim() || !body.trim() || !startTime || leads.length === 0) {
      setMessage('Enter a subject, body, start time and upload a leads file.')
      return
    }

    if (!senderId) {
      setMessage('Create a sender before scheduling emails.')
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
      for (let index = 0; index < leads.length; index++) {
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
              recipientEmail: leads[index],
              subject: subject.trim(),
              body: body.trim(),
              scheduledAt: scheduledAt.toISOString(),
            }),
          })

          const result = await response.json()

          if (!response.ok) {
            throw new Error(result.message || 'Scheduling failed.')
          }

          succeeded++
        } catch (error) {
          errors.push(
            `${leads[index]}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          )
        }
      }

      await loadData()

      if (errors.length === 0) {
        setMessage(`Successfully scheduled ${succeeded} email(s).`)
        setShowCompose(false)
        setSubject('')
        setBody('')
        setStartTime('')
        setLeads([])
        setActiveTab('Scheduled')
      } else {
        setMessage(
          `Scheduled ${succeeded} of ${leads.length} emails. ` +
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 font-bold text-white">
              R
            </div>
            <div>
              <h1 className="text-lg font-bold">ReachInbox</h1>
              <p className="text-xs text-slate-500">Email Scheduler</p>
            </div>
          </div>
          <button
            onClick={() => void loadData()}
            className="text-sm font-medium text-violet-700 hover:text-violet-900"
          >
            Refresh data
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">
              Email campaigns
            </h2>
            <p className="mt-2 text-slate-500">
              Schedule, manage and track your email outreach.
            </p>
          </div>
          <button
            onClick={() => {
              setMessage('')
              setShowCompose(true)
            }}
            className="rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white hover:bg-violet-700"
          >
            + Compose New Email
          </button>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Stat label="Total emails" value={emails.length} />
          <Stat label="Scheduled / Pending" value={scheduledEmails.length} />
          <Stat label="Sent successfully" value={totalSent} />
        </div>

        {message && !showCompose && (
          <div className="mt-5 rounded-lg border border-slate-200 bg-white p-4 text-sm">
            {message}
          </div>
        )}

        <section className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex gap-6 border-b border-slate-200 px-6">
            {(['Scheduled', 'Sent'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`border-b-2 px-1 py-4 text-sm font-semibold ${
                  activeTab === tab
                    ? 'border-violet-600 text-violet-700'
                    : 'border-transparent text-slate-500'
                }`}
              >
                {tab === 'Sent' ? 'Sent / Failed' : 'Scheduled'} Emails
              </button>
            ))}
          </div>

          {loading ? (
            <div className="px-6 py-20 text-center text-slate-500">
              Loading emails from backend...
            </div>
          ) : visibleEmails.length === 0 ? (
            <div className="px-6 py-20 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-2xl">
                ✉
              </div>
              <h3 className="mt-4 font-semibold">
                No {activeTab.toLowerCase()} emails yet
              </h3>
              <p className="mt-2 text-sm text-slate-500">
                Your backend email records will appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-6 py-4 font-medium">Recipient</th>
                    <th className="px-6 py-4 font-medium">Subject</th>
                    <th className="px-6 py-4 font-medium">Scheduled time</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleEmails.map(email => (
                    <tr key={email.id}>
                      <td className="px-6 py-4">{email.recipient_email}</td>
                      <td className="px-6 py-4">
                        <div>{email.subject}</div>
                        {email.error_message && (
                          <p className="mt-1 text-xs text-red-600">
                            {email.error_message}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {new Date(email.scheduled_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            email.status === 'sent'
                              ? 'bg-green-50 text-green-700'
                              : email.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {email.status}
                        </span>
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
        <div className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4">
          <div className="my-auto w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Compose campaign</h2>
              <button
                onClick={() => setShowCompose(false)}
                className="text-2xl text-slate-400"
              >
                ×
              </button>
            </div>

            <label className="mt-5 block text-sm font-medium">Sender</label>
            <select
              value={senderId}
              onChange={event => setSenderId(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">Select a sender</option>
              {senders.map(sender => (
                <option key={sender.id} value={sender.id}>
                  {sender.name} ({sender.email})
                </option>
              ))}
            </select>

            {selectedSender && (
              <p className="mt-2 text-xs text-slate-500">
                Limit: {selectedSender.hourly_limit} emails/hour · Minimum
                interval: {selectedSender.min_interval_seconds} seconds
              </p>
            )}

            <label className="mt-5 block text-sm font-medium">Subject</label>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              placeholder="Your email subject"
            />

            <label className="mt-4 block text-sm font-medium">Email body</label>
            <textarea
              value={body}
              onChange={event => setBody(event.target.value)}
              rows={4}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              placeholder="Write your message..."
            />

            <label className="mt-4 block text-sm font-medium">
              Upload leads (.csv or .txt)
            </label>
            <input
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              onChange={event => parseFile(event.target.files?.[0])}
              className="mt-2 block w-full rounded-lg border border-slate-300 p-3 text-sm"
            />
            <p className="mt-2 text-sm text-slate-500">
              {leads.length} unique email addresses detected
            </p>

            <label className="mt-4 block text-sm font-medium">Start time</label>
            <input
              type="datetime-local"
              min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
              value={startTime}
              onChange={event => setStartTime(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
            />

            <div className="mt-4">
              <label className="block text-sm font-medium">
                Delay between scheduled emails (seconds)
              </label>
              <input
                type="number"
                min={1}
                value={delay}
                onChange={event =>
                  setDelay(Math.max(1, Number(event.target.value)))
                }
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <p className="mt-3 rounded-lg bg-violet-50 p-3 text-xs text-violet-800">
              Emails are scheduled through your backend and BullMQ. Actual send
              timing is also subject to the sender's rate limits.
            </p>

            {message && (
              <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-red-600">
                {message}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowCompose(false)}
                disabled={submitting}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => void scheduleEmails()}
                disabled={submitting}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {submitting ? 'Scheduling...' : 'Schedule emails'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-bold">{value}</p>
    </div>
  )
}

export default App
