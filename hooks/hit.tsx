import type { ClientModule } from 'claude-code'

export type HitProps = { id: string }

// An invisible click area laid over a drawn icon. It tells the hooks module
// when the pointer comes onto the icon or leaves it (for the hover look),
// and which icon was clicked (left button, on release).
const Hit: ClientModule<HitProps, { over: boolean }> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    const over = e.type !== 'leave'
    if (over !== Boolean(surface.state?.over)) {
      surface.setState({ over })
      surface.post({ over, id: props.id })
    }
    if (e.type === 'up' && (e.button ?? 'left') === 'left') surface.post({ press: props.id })
  })
  return <Box width="100%" height="100%" />
}

export default Hit
