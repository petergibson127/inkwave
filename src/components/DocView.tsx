import { Fragment, type ReactNode } from 'react'
import type { TiptapJSON } from '../types/document'

// A small, read-only renderer for a TiptapJSON document — used by the snapshot viewer to show an
// old version exactly as written, with no editor/ProseMirror machinery. Handles the node + mark
// types Inkwave produces (paragraphs, headings, lists, blockquote, code, and inline marks).

type Node = { type?: string; text?: string; marks?: Array<{ type: string }>; attrs?: Record<string, unknown>; content?: Node[] }

function applyMarks(text: string, marks: Node['marks'], key: number): ReactNode {
  let el: ReactNode = text
  for (const m of marks ?? []) {
    if (m.type === 'bold') el = <strong>{el}</strong>
    else if (m.type === 'italic') el = <em>{el}</em>
    else if (m.type === 'underline') el = <u>{el}</u>
    else if (m.type === 'strike') el = <s>{el}</s>
    else if (m.type === 'code') el = <code>{el}</code>
  }
  return <Fragment key={key}>{el}</Fragment>
}

function inline(nodes: Node[] | undefined): ReactNode {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'hardBreak') return <br key={i} />
    if (n.type === 'text') return applyMarks(n.text ?? '', n.marks, i)
    return <Fragment key={i}>{inline(n.content)}</Fragment>
  })
}

function block(node: Node, key: number): ReactNode {
  const kids = node.content
  switch (node.type) {
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2)
      const Tag = (`h${Math.min(6, Math.max(1, level))}`) as keyof JSX.IntrinsicElements
      return <Tag key={key}>{inline(kids)}</Tag>
    }
    case 'bulletList':
      return <ul key={key}>{(kids ?? []).map((c, i) => block(c, i))}</ul>
    case 'orderedList':
      return <ol key={key}>{(kids ?? []).map((c, i) => block(c, i))}</ol>
    case 'listItem':
      return <li key={key}>{(kids ?? []).map((c, i) => block(c, i))}</li>
    case 'blockquote':
      return <blockquote key={key}>{(kids ?? []).map((c, i) => block(c, i))}</blockquote>
    case 'codeBlock':
      return <pre key={key}><code>{inline(kids)}</code></pre>
    case 'paragraph':
      return <p key={key}>{inline(kids)}</p>
    default:
      // Unknown container — render its children if any, else nothing.
      return kids ? <Fragment key={key}>{kids.map((c, i) => block(c, i))}</Fragment> : null
  }
}

export function DocView({ doc }: { doc: TiptapJSON }) {
  const top = (doc as Node).content ?? []
  return <>{top.map((n, i) => block(n, i))}</>
}
