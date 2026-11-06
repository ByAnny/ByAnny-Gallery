import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { QRCodeSVG } from 'qrcode.react'
import './Admin.css'

const ADMIN_ID = import.meta.env.VITE_ADMIN_USER_ID
const BUCKET = 'fotografias-xv'
const PHOTO_PAGE_SIZE = 500
const DELETE_BATCH_SIZE = 100

function Admin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)

  const [events, setEvents] = useState([])
  const [eventName, setEventName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  // Confirmación personalizada de eliminación
  const [eventToDelete, setEventToDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deletionProgress, setDeletionProgress] = useState('')

  const fetchEvents = async () => {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      setMessage('No se pudieron cargar los eventos.')
      return
    }

    setEvents(data || [])
  }

  useEffect(() => {
    let mounted = true

    const checkSession = async () => {
      const { data } = await supabase.auth.getSession()
      const user = data.session?.user

      if (!mounted) return

      if (user?.id === ADMIN_ID) {
        setLoggedIn(true)
        await fetchEvents()
      }
    }

    checkSession()

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const isAdmin = session?.user?.id === ADMIN_ID

        setLoggedIn(isAdmin)

        if (!isAdmin) {
          setEvents([])
        } else {
          setTimeout(() => {
            if (mounted) fetchEvents()
          }, 0)
        }
      }
    )

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const handleLogin = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) throw error

      if (data.user?.id !== ADMIN_ID) {
        await supabase.auth.signOut()
        throw new Error('Esta cuenta no tiene permisos de administración.')
      }

      setLoggedIn(true)
      await fetchEvents()

    } catch (error) {
      setMessage(
        error.message === 'Esta cuenta no tiene permisos de administración.'
          ? error.message
          : 'No se pudo iniciar sesión. Revisa tu correo y contraseña.'
      )
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setLoggedIn(false)
    setEvents([])
    setEmail('')
    setPassword('')
  }

  const createEvent = async (event) => {
    event.preventDefault()

    if (!eventName.trim()) return

    setCreating(true)
    setMessage('')

    try {
      const slugBase = eventName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

      const slug = `${slugBase}-${Date.now().toString().slice(-5)}`

      const { error } = await supabase
        .from('events')
        .insert({
          name: eventName.trim(),
          slug,
          description: description.trim(),
          is_active: true
        })

      if (error) throw error

      setEventName('')
      setDescription('')
      setMessage('¡Tu evento se creó correctamente! 💚')
      await fetchEvents()

    } catch (error) {
      setMessage('No se pudo crear el evento: ' + error.message)
    } finally {
      setCreating(false)
    }
  }

  const toggleEvent = async (event) => {
    const { error } = await supabase
      .from('events')
      .update({ is_active: !event.is_active })
      .eq('id', event.id)

    if (error) {
      setMessage('No se pudo actualizar el evento: ' + error.message)
      return
    }

    setMessage(
      event.is_active
        ? 'El evento se desactivó correctamente.'
        : '¡El evento se activó correctamente!'
    )

    await fetchEvents()
  }

  const copyEventLink = async (event) => {
    const url = `${window.location.origin}/evento/${event.slug}`

    try {
      await navigator.clipboard.writeText(url)
      setMessage('¡Enlace copiado correctamente! 💚')
    } catch {
      setMessage('No se pudo copiar el enlace. Puedes copiarlo manualmente: ' + url)
    }
  }

  const downloadQR = (event) => {
    const svg = document.getElementById(`qr-${event.id}`)

    if (!svg) {
      setMessage('No se encontró el código QR.')
      return
    }

    const svgData = new XMLSerializer().serializeToString(svg)
    const blob = new Blob([svgData], {
      type: 'image/svg+xml;charset=utf-8'
    })

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = `QR-${event.slug}.svg`
    document.body.appendChild(link)
    link.click()
    link.remove()

    setTimeout(() => URL.revokeObjectURL(url), 1000)

    setMessage('¡Código QR descargado! 💚')
  }

  // Abrir confirmación personalizada de eliminación
  const deleteEvent = (event) => {
    if (event.is_active) {
      setMessage('Primero debes desactivar el evento para poder eliminarlo.')
      return
    }

    setMessage('')
    setDeletionProgress('')
    setEventToDelete(event)
  }

  // Obtener todas las fotografías del evento por páginas
  const getAllEventPhotos = async (eventId) => {
    const allPhotos = []
    let from = 0

    while (true) {
      const { data, error } = await supabase
        .from('event_photos')
        .select('id, storage_path')
        .eq('event_id', eventId)
        .range(from, from + PHOTO_PAGE_SIZE - 1)

      if (error) throw error

      allPhotos.push(...data)

      if (data.length < PHOTO_PAGE_SIZE) break

      from += PHOTO_PAGE_SIZE
    }

    return allPhotos
  }

  // Eliminar todas las fotografías y después el evento
  const confirmDeleteEvent = async () => {
    if (!eventToDelete || deleting) return

    setDeleting(true)
    setMessage('')
    setDeletionProgress('Buscando fotografías del evento...')

    try {
      const eventId = eventToDelete.id
      const allPhotos = await getAllEventPhotos(eventId)
      const totalPhotos = allPhotos.length

      if (totalPhotos === 0) {
        setDeletionProgress('No se encontraron fotografías. Eliminando evento...')
      }

      // Eliminar fotografías en grupos de 100
      for (let i = 0; i < totalPhotos; i += DELETE_BATCH_SIZE) {
        const batch = allPhotos.slice(i, i + DELETE_BATCH_SIZE)

        const paths = batch.map((photo) => photo.storage_path)

        setDeletionProgress(
          `Eliminando fotografías... ${Math.min(i + batch.length, totalPhotos)} de ${totalPhotos}`
        )

        // Primero eliminar los archivos de Storage
        if (paths.length > 0) {
          const { error: storageError } = await supabase.storage
            .from(BUCKET)
            .remove(paths)

          if (storageError) throw storageError
        }

        // Después eliminar sus registros de la base de datos
        const ids = batch.map((photo) => photo.id)

        const { error: databaseError } = await supabase
          .from('event_photos')
          .delete()
          .in('id', ids)

        if (databaseError) throw databaseError
      }

      // Finalmente eliminar el evento
      setDeletionProgress('Finalizando eliminación del evento...')

      const { error: eventError } = await supabase
        .from('events')
        .delete()
        .eq('id', eventId)

      if (eventError) throw eventError

      setEventToDelete(null)
      setDeletionProgress('')
      setMessage(
        `¡Evento y ${totalPhotos} fotografías eliminados correctamente! 💚`
      )

      await fetchEvents()

    } catch (error) {
      const errorMessage =
        'No se pudo completar la eliminación: ' + error.message +
        '. Puedes volver a intentarlo.'

      setDeletionProgress(errorMessage)
      setMessage(errorMessage)

    } finally {
      setDeleting(false)
    }
  }

  if (!loggedIn) {
    return (
      <main className="admin-page">
        <form className="admin-card" onSubmit={handleLogin}>
          <span className="admin-subtitle">BYANNY</span>
          <h1>Administración</h1>
          <p>Inicia sesión para gestionar tus eventos.</p>

          <label>Correo electrónico</label>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Tu correo electrónico"
            required
          />

          <label>Contraseña</label>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Tu contraseña"
            required
          />

          {message && <p className="admin-error">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading ? 'Iniciando sesión...' : 'Iniciar sesión'}
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="admin-page dashboard-page">
      <section className="dashboard">

        <header className="dashboard-header">
          <div>
            <span className="admin-subtitle">XV FOTOGRAFÍAS</span>
            <h1>Mi panel</h1>
            <p>Administra todos tus eventos desde aquí.</p>
          </div>

          <button className="logout-button" onClick={handleLogout}>
            Cerrar sesión
          </button>
        </header>

        <div className="dashboard-stats">
          <article className="stat-card">
            <span>Eventos creados</span>
            <strong>{events.length}</strong>
          </article>

          <article className="stat-card">
            <span>Eventos activos</span>
            <strong>{events.filter((event) => event.is_active).length}</strong>
          </article>
        </div>

        <section className="dashboard-section">
          <h2>Crear nuevo evento</h2>
          <p>Prepara una nueva galería para compartir fotografías.</p>

          <form className="event-form" onSubmit={createEvent}>
            <label>Nombre del evento</label>
            <input
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              placeholder="Ej. XV años de Sofía"
              required
            />

            <label>Descripción</label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Una pequeña descripción del evento..."
              rows="3"
            />

            <button type="submit" disabled={creating}>
              {creating ? 'Creando evento...' : '+ Crear evento'}
            </button>
          </form>
        </section>

        {message && <p className="dashboard-message">{message}</p>}

        <section className="dashboard-section">
          <h2>Mis eventos</h2>

          {events.length === 0 ? (
            <div className="empty-events">
              <span>✧</span>
              <h3>Aún no tienes eventos</h3>
              <p>Cuando crees tu primer evento aparecerá aquí.</p>
            </div>
          ) : (
            <div className="event-list">
              {events.map((event) => {
                const eventUrl = `${window.location.origin}/evento/${event.slug}`

                return (
                  <article className="event-card" key={event.id}>
                    <div className="event-info">
                      <h3>{event.name}</h3>
                      <p>{event.description || 'Sin descripción'}</p>

                      <small>/{event.slug}</small>

                      <span className={event.is_active ? 'status-active' : 'status-inactive'}>
                        {event.is_active ? 'Activo' : 'Inactivo'}
                      </span>

                      <p className="event-url">{eventUrl}</p>

                      <div className="event-actions">
                        <button
                          type="button"
                          onClick={() => copyEventLink(event)}
                        >
                          Copiar enlace
                        </button>

                        <button
                          type="button"
                          onClick={() => toggleEvent(event)}
                        >
                          {event.is_active ? 'Desactivar' : 'Activar'}
                        </button>

                        <button
                          type="button"
                          className="delete-event"
                          onClick={() => deleteEvent(event)}
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>

                    <div className="event-qr">
                      <QRCodeSVG
                        id={`qr-${event.id}`}
                        value={eventUrl}
                        size={150}
                        level="H"
                        includeMargin
                      />

                      <button
                        type="button"
                        onClick={() => downloadQR(event)}
                      >
                        Descargar QR
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        {/* Ventana personalizada de confirmación */}
        {eventToDelete && (
          <div
            className="event-delete-overlay"
            onClick={() => {
              if (!deleting) {
                setEventToDelete(null)
                setDeletionProgress('')
              }
            }}
          >
            <div
              className="event-delete-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="delete-modal-icon">♡</span>

              <h2>¿Eliminar este evento?</h2>

              <p>
                Estás a punto de eliminar permanentemente
                <strong> {eventToDelete.name}</strong>.
              </p>

              <p className="delete-modal-warning">
                Se eliminarán todas las fotografías almacenadas en este evento.
                Esta acción no se puede deshacer.
              </p>

              {deletionProgress && (
                <p className="delete-modal-progress" aria-live="polite">
                  {deletionProgress}
                </p>
              )}

              <div className="delete-modal-actions">
                <button
                  type="button"
                  className="delete-modal-cancel"
                  onClick={() => {
                    setEventToDelete(null)
                    setDeletionProgress('')
                  }}
                  disabled={deleting}
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  className="delete-modal-confirm"
                  onClick={confirmDeleteEvent}
                  disabled={deleting}
                >
                  {deleting ? 'Eliminando...' : 'Sí, eliminar todo'}
                </button>
              </div>
            </div>
          </div>
        )}

      </section>
    </main>
  )
}

export default Admin