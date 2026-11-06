import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from './supabase'
import './App.css'

function App() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false

    async function loadEvents() {
      try {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession()

        if (sessionError) throw sessionError

        if (!sessionData.session?.user) {
          const { error } = await supabase.auth.signInAnonymously()
          if (error) throw error
        }

        const { data, error } = await supabase
          .from('events')
          .select('id, name, slug, description')
          .eq('is_active', true)
          .order('created_at', { ascending: false })

        if (error) throw error

        if (!cancelled) setEvents(data || [])

      } catch (error) {
        if (!cancelled) {
          setMessage('No se pudieron cargar los eventos: ' + error.message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadEvents()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <header className="hero">
        <span className="subtitle">
          BYANNY
        </span>

        <h1>Momentos especiales</h1>

        <p>Un día mágico, miles de recuerdos.</p>

        <div className="divider"></div>

        <h2>Bienvenidos</h2>

        <p className="description">
          Encuentra tu evento y comparte las fotografías
          de esos momentos que merecen quedarse para siempre.
        </p>
      </header>

      <section className="gallery">
        <h2>Nuestros eventos</h2>

        <p>Selecciona una celebración para entrar a su galería.</p>

        {loading ? (
          <div className="empty-gallery">
            <span>♡</span>
            <p>Cargando eventos...</p>
          </div>
        ) : message ? (
          <div className="empty-gallery">
            <p>{message}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="empty-gallery">
            <span>♡</span>
            <p>Próximamente encontrarás aquí nuestras celebraciones.</p>
          </div>
        ) : (
          <div className="event-gallery-list">
            {events.map((event) => (
              <article className="public-event-card" key={event.id}>
                <span className="event-decoration">✧</span>

                <h3>{event.name}</h3>

                <p>
                  {event.description || 'Un día mágico, miles de recuerdos.'}
                </p>

                <Link
                  className="event-link"
                  to={`/evento/${event.slug}`}
                >
                  Ver galería ♡
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer>
        Hecho con amor ♡
      </footer>
    </div>
  )
}

export default App