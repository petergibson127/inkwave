import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Edit } from './routes/Edit'
import { About } from './routes/About'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/edit" element={<Edit />} />
        <Route path="/about" element={<About />} />
        <Route path="*" element={<Navigate to="/edit" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
