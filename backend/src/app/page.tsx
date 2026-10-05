import { connection } from 'next/server'
import styles from './page.module.css'

export default async function Home() {
  await connection() // read env at request time, not build time

  const status = [
    { label: 'TypeSafe key', ok: !!process.env.TYPESAFE_API_KEY, off: 'Missing' },
    { label: 'AI Gateway fallback', ok: !!process.env.AI_GATEWAY_API_KEY, off: 'Not set' },
  ]

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>JevElements</h1>
      <p className={styles.lead}>
        Classifies captured sections sent to <code>POST /api/analyze</code> with{' '}
        <a href="https://docs.typesafe.ai/introduction">Jev</a>, falling back to Vercel AI Gateway.
      </p>
      <ul className={styles.status}>
        {status.map(({ label, ok, off }) => (
          <li key={label} className={styles.row}>
            <span>{label}</span>
            <span className={styles.value}>
              <span className={`${styles.dot} ${ok ? styles.on : ''}`} />
              {ok ? 'Configured' : off}
            </span>
          </li>
        ))}
      </ul>
    </main>
  )
}
