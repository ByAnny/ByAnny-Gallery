import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from './supabase'
import './App.css'

const BUCKET = 'fotografias-xv'
const PHOTO_BATCH_SIZE = 5
const UPLOAD_BATCH_SIZE = 3

function EventGallery() {
  const { slug } = useParams()

  const [event, setEvent] = useState(null)
  const [photos, setPhotos] = useState([])
  const [userId, setUserId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [message, setMessage] = useState('')
  const [photoToDelete, setPhotoToDelete] = useState(null)
  const [eventStatus, setEventStatus] = useState('loading')

  const photosRef = useRef([])
  const statusRef = useRef('loading')

  const changeStatus = (status) => {
    statusRef.current = status
    setEventStatus(status)
  }

  const releasePhotos = () => {
    photosRef.current.forEach((photo) => {
      URL.revokeObjectURL(photo.url)
    })

    photosRef.current = []
    setPhotos([])
  }

  // Preparar acceso y buscar el evento
  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession()

        if (sessionError) throw sessionError

        let user = sessionData.session?.user

        if (!user) {
          const { data, error } =
            await supabase.auth.signInAnonymously()

          if (error) throw error
          user = data.user
        }

        if (!user || cancelled) return

        setUserId(user.id)

        const { data: eventData, error } = await supabase
          .from('events')
          .select('id, name, description, close_at')
          .eq('slug', slug)
          .eq('is_active', true)
          .maybeSingle()

        if (error) throw error

        if (!eventData) {
          if (!cancelled) changeStatus('closed')
          return
        }

        if (
          eventData.close_at &&
          new Date(eventData.close_at) <= new Date()
        ) {
          if (!cancelled) changeStatus('closed')
          return
        }

        if (!cancelled) {
          setEvent(eventData)
          changeStatus('active')
        }

      } catch (error) {
        if (!cancelled) {
          setMessage('No se pudo preparar la galería: ' + error.message)
          changeStatus('error')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    initialize()

    return () => {
      cancelled = true
    }
  }, [slug])

  // Cargar fotografías mediante descargas autenticadas
  useEffect(() => {
    if (!event || !userId || eventStatus !== 'active') return

    let cancelled = false
    let refreshing = false

    const refreshPhotos = async () => {
      if (refreshing || cancelled || statusRef.current !== 'active') return

      refreshing = true

      try {
        const { data, error } = await supabase
          .from('event_photos')
          .select('*')
          .eq('event_id', event.id)
          .order('created_at', { ascending: false })
          .limit(500)

        if (error) throw error

        const previous = photosRef.current
        const previousById = new Map(
          previous.map((photo) => [photo.id, photo])
        )

        const newPhotos = (data || []).filter(
          (photo) => !previousById.has(photo.id)
        )

        const updated = []

        for (let i = 0; i < newPhotos.length; i += PHOTO_BATCH_SIZE) {
          if (cancelled || statusRef.current !== 'active') break

          const batch = newPhotos.slice(i, i + PHOTO_BATCH_SIZE)

          const results = await Promise.all(
            batch.map(async (photo) => {
              const { data: file, error: downloadError } =
                await supabase.storage
                  .from(BUCKET)
                  .download(photo.storage_path)

              if (downloadError) throw downloadError

              return {
                id: photo.id,
                path: photo.storage_path,
                url: URL.createObjectURL(file),
                name: photo.original_name,
                ownerId: photo.owner_id
              }
            })
          )

          updated.push(...results)
        }

        if (cancelled || statusRef.current !== 'active') {
          updated.forEach((photo) => URL.revokeObjectURL(photo.url))
          return
        }

        const currentById = new Map(
          updated.map((photo) => [photo.id, photo])
        )

        const finalPhotos = (data || []).map((photo) => {
          const existing = previousById.get(photo.id)

          if (existing) {
            previousById.delete(photo.id)

            return {
              ...existing,
              name: photo.original_name,
              ownerId: photo.owner_id
            }
          }

          return currentById.get(photo.id)
        }).filter(Boolean)

        previousById.forEach((photo) => {
          URL.revokeObjectURL(photo.url)
        })

        photosRef.current = finalPhotos
        setPhotos(finalPhotos)

      } catch (error) {
        if (!cancelled) {
          setMessage(
            'No se pudieron cargar las fotografías: ' + error.message
          )
        }
      } finally {
        refreshing = false
      }
    }

    refreshPhotos()

    const intervalId = window.setInterval(refreshPhotos, 30000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)

      photosRef.current.forEach((photo) => {
        URL.revokeObjectURL(photo.url)
      })

      photosRef.current = []
    }
  }, [event, userId, eventStatus])

  // Comprobar periódicamente si el evento sigue activo
  useEffect(() => {
    if (!event) return

    let cancelled = false

    const checkEvent = async () => {
      const { data, error } = await supabase
        .from('events')
        .select('id, is_active, close_at')
        .eq('id', event.id)
        .maybeSingle()

      if (cancelled) return

      if (error || !data) {
        releasePhotos()
        changeStatus('closed')
        return
      }

      const expired =
        data.close_at &&
        new Date(data.close_at) <= new Date()

      if (!data.is_active || expired) {
        releasePhotos()
        changeStatus('closed')
      } else {
        changeStatus('active')
      }
    }

    checkEvent()

    const intervalId = window.setInterval(checkEvent, 5000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [event])

  // Subir fotografías en grupos de tres
  const handlePhotos = async (inputEvent) => {
    const files = Array.from(inputEvent.target.files)
      .filter((file) => file.type.startsWith('image/'))

    if (!userId || !event || statusRef.current !== 'active') {
      setMessage('Esta galería ya no está disponible.')
      inputEvent.target.value = ''
      return
    }

    if (files.length === 0) {
      setMessage('Selecciona al menos una fotografía.')
      inputEvent.target.value = ''
      return
    }

    setUploading(true)
setMessage('')
setUploadProgress('Preparando tus fotografías...')

    try {
      const validFiles = files.filter(
        (file) => file.size <= 50 * 1024 * 1024
      )

      const oversized = files.length - validFiles.length

      let successful = 0
      let failed = 0

      if (validFiles.length === 0) {
        throw new Error('Todas las fotografías superan el límite de 50 MB.')
      }

      const uploadOne = async (file) => {
        if (statusRef.current !== 'active') {
          return { success: false }
        }

        const safeName = file.name
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9._-]/g, '-')

        const path = `${event.id}/${userId}/${crypto.randomUUID()}-${safeName}`

        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, {
            contentType: file.type,
            upsert: false
          })

        if (uploadError) {
          return { success: false, error: uploadError.message }
        }

        const { error: insertError } = await supabase
          .from('event_photos')
          .insert({
            event_id: event.id,
            owner_id: userId,
            storage_path: path,
            original_name: file.name
          })

        if (insertError) {
          await supabase.storage.from(BUCKET).remove([path])
          return { success: false, error: insertError.message }
        }

        return { success: true }
      }

      for (let i = 0; i < validFiles.length; i += UPLOAD_BATCH_SIZE) {
        if (statusRef.current !== 'active') {
          failed += validFiles.length - i
          break
        }

        const batch = validFiles.slice(i, i + UPLOAD_BATCH_SIZE)

        setUploadProgress(
  `Subiendo ${Math.min(i + batch.length, validFiles.length)} de ${validFiles.length} fotografías`
)

        const results = await Promise.all(
          batch.map((file) => uploadOne(file))
        )

        results.forEach((result) => {
          if (result.success) {
            successful++
          } else {
            failed++
          }
        })
      }

      failed += oversized

      if (successful > 0 && failed === 0) {
        setMessage(`¡Se compartieron ${successful} fotografías correctamente! ♡`)
      } else if (successful > 0) {
        setMessage(
          `Se compartieron ${successful} fotografías. ${failed} no pudieron subirse.`
        )
      } else {
        setMessage('No se pudieron subir las fotografías. Inténtalo nuevamente.')
      }

    } catch (error) {
      setMessage('Error al subir las fotografías: ' + error.message)
    } finally {
      setUploading(false)
      setUploadProgress('')
      inputEvent.target.value = ''
    }
  }

  // Eliminar una fotografía propia
  const deletePhoto = async (photo) => {
    try {
      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .remove([photo.path])

      if (storageError) throw storageError

      const { error: databaseError } = await supabase
        .from('event_photos')
        .delete()
        .eq('id', photo.id)

      if (databaseError) throw databaseError

      URL.revokeObjectURL(photo.url)

      photosRef.current = photosRef.current.filter(
        (item) => item.id !== photo.id
      )

      setPhotos((previous) =>
        previous.filter((item) => item.id !== photo.id)
      )

      setMessage('Fotografía eliminada correctamente.')

    } catch (error) {
      setMessage('No se pudo eliminar la fotografía: ' + error.message)
    }

    setPhotoToDelete(null)
  }

  // Descargar fotografía
  const downloadPhoto = async (photo) => {
    try {
      setMessage('Preparando fotografía...')

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(photo.path)

      if (error) throw error

      const url = URL.createObjectURL(data)
      const link = document.createElement('a')

      link.href = url
      link.download = photo.name

      document.body.appendChild(link)
      link.click()
      link.remove()

      setTimeout(() => URL.revokeObjectURL(url), 1000)

      setMessage('¡Fotografía descargada correctamente! ♡')

    } catch (error) {
      setMessage('No se pudo descargar la fotografía: ' + error.message)
    }
  }

  // Pantallas de carga y cierre
  if (loading || eventStatus === 'loading') {
    return (
      <main className="app">
        <header className="hero">
          <h1>Preparando galería...</h1>
          <p>Un momento, por favor. ♡</p>
        </header>
      </main>
    )
  }

  if (eventStatus === 'closed') {
    return (
      <main className="gallery-closed">
        <section className="closed-card">
          <span className="closed-decoration">✧</span>
          <span className="closed-heart">♡</span>
          <h1>Esta galería ha finalizado</h1>
          <div className="closed-divider"></div>
          <p>
            Gracias por compartir y formar parte
            de estos recuerdos tan especiales.
          </p>
          <span className="closed-footer">Con cariño, XV Fotografías</span>
          <span className="closed-decoration bottom">✧</span>
        </section>
      </main>
    )
  }

  if (eventStatus === 'error') {
    return (
      <main className="app">
        <header className="hero">
          <h1>No pudimos abrir la galería</h1>
          <p>{message}</p>
        </header>
      </main>
    )
  }

  return (
    <div className="app">
        {uploading && (
  <div className="upload-overlay">
    <div className="upload-message">
      <div className="upload-spinner"></div>

      <h2>¡Estamos preparando tus recuerdos!</h2>

      <p>
        Tus fotografías se están cargando.
        Por favor, espera un momento y no cierres esta página. ♡
      </p>

      <span>{uploadProgress}</span>
    </div>
  </div>
)}
      <header className="hero">
        <span className="subtitle">UNA CELEBRACIÓN ESPECIAL</span>
        <h1>{event?.name}</h1>
        <p>{event?.description || 'Un día mágico, miles de recuerdos.'}</p>
        <div className="divider"></div>
        <h2>¡Comparte tus fotografías!</h2>
        <p className="description">
          Ayúdanos a guardar cada momento de esta celebración.
          Selecciona tus mejores fotografías y compártelas.
        </p>

        <label className="upload-button">
          {uploading ? 'Subiendo fotografías...' : 'Compartir fotografías'}
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handlePhotos}
            disabled={uploading || !userId}
            hidden
          />
        </label>

        {message && <p>{message}</p>}
      </header>

      <section className="gallery">
        <h2>Nuestros recuerdos</h2>
        <p>Los momentos más bonitos de esta celebración.</p>

        {photos.length === 0 ? (
          <div className="empty-gallery">
            <span>♡</span>
            <p>¡Aquí aparecerán las fotografías del evento!</p>
          </div>
        ) : (
          <div className="photo-grid">
            {photos.map((photo) => (
              <div className="photo-card" key={photo.id}>
                <img src={photo.url} alt={photo.name} />

                <button
                  type="button"
                  className="download-button"
                  onClick={() => downloadPhoto(photo)}
                  title="Descargar fotografía"
                  aria-label="Descargar fotografía"
                >
                  ↓
                </button>

                {photo.ownerId === userId && (
                  <button
                    type="button"
                    className="delete-button"
                    onClick={() => setPhotoToDelete(photo)}
                    title="Eliminar fotografía"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer>Hecho con amor ♡</footer>

      {photoToDelete && (
        <div
          className="modal-overlay"
          onClick={() => setPhotoToDelete(null)}
        >
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>¿Eliminar fotografía?</h2>
            <p>¿Estás segura de que deseas eliminar este recuerdo?</p>

            <div className="modal-buttons">
              <button
                type="button"
                className="cancel-button"
                onClick={() => setPhotoToDelete(null)}
              >
                Cancelar
              </button>

              <button
                type="button"
                className="confirm-delete-button"
                onClick={() => deletePhoto(photoToDelete)}
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default EventGallery