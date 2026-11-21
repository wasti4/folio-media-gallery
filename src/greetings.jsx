const greetings = [
  {
    text: 'Hello', language: 'en', viewBox: '12 6 430 164',
    strokes: [
      ['M24 110C46 103 64 76 77 51C85 35 94 26 102 28C109 30 102 47 97 59C83 89 70 118 61 148', 510, 5.6, 55],
      ['M163 28C150 57 134 101 121 136C115 151 120 155 130 152C142 148 151 139 160 128', 400, 5.7, 45],
      ['M78 99C98 93 118 89 143 90', 185, 4.1, 45],
      ['M160 128C178 126 193 119 200 108C207 96 198 91 187 97C174 104 165 123 170 136C178 157 205 148 225 130', 438, 5.2],
      ['M225 130C246 109 273 71 279 46C285 21 272 23 260 36C240 56 226 88 219 116C214 138 219 154 235 152C251 150 267 137 282 123', 493, 5.05],
      ['M282 123C302 102 324 62 328 40C333 17 321 23 310 34C292 53 278 90 271 115C265 138 272 151 286 151C299 151 319 136 330 122', 491, 5.05],
      ['M330 122C344 106 358 104 370 110C384 117 382 137 367 146C354 154 338 151 334 139C330 127 341 114 352 109C366 103 375 112 386 116C401 121 415 113 427 103', 497, 5.15],
    ],
  },
  {
    text: 'Привет', language: 'ru', viewBox: '7 14 527 176',
    strokes: [
      ['M19 49C34 40 60 38 84 37C109 36 135 35 153 37C159 38 157 43 149 45', 315, 5.25, 34],
      ['M62 40C57 63 44 113 36 135C31 148 37 152 48 145', 300, 5.5, 42],
      ['M126 39C119 69 107 111 102 132C97 153 110 151 128 135', 350, 5.5],
      ['M128 135C137 125 146 112 155 103C152 123 143 153 138 176', 280, 5.1, 40],
      ['M147 142C151 125 166 98 181 101C200 105 188 131 177 142C168 151 161 148 159 143C169 150 187 148 202 133', 377, 5.3],
      ['M202 133C208 126 213 117 218 105C213 125 205 148 218 150C231 152 249 123 255 105C252 121 241 147 252 150C263 152 275 136 281 128', 430, 5.1],
      ['M281 128C290 113 317 86 322 67C329 45 315 44 303 58C289 74 281 104 278 126C274 147 285 154 299 148C311 143 317 130 313 121C308 109 291 111 289 122C296 128 311 130 328 125', 466, 5.15],
      ['M328 125C342 123 361 117 366 106C371 94 359 92 349 97C336 104 328 122 327 133C327 151 347 156 367 144C379 137 388 125 397 110', 385, 5.1],
      ['M397 110C401 102 404 99 407 103C410 109 399 136 394 149C404 132 420 100 432 101C444 101 434 127 425 150C436 128 451 101 464 103C479 105 462 129 462 144C462 155 479 148 494 135C505 126 513 119 520 114', 511, 5.15],
    ],
  },
  {
    text: '你好', language: 'zh-CN', viewBox: '18 14 344 151',
    strokes: [
      ['M74 31C65 53 49 75 30 91', 257, 6.3, 50],
      ['M56 67C54 90 53 116 52 146', 248, 6.05, 45],
      ['M113 29C106 51 96 68 81 82', 220, 6.35, 40],
      ['M100 59Q126 60 164 53C164 62 157 71 151 76', 243, 5.6, 40],
      ['M123 66C124 90 124 121 122 142Q120 151 103 138', 284, 6.45, 36],
      ['M104 94Q93 116 77 130', 186, 5.55, 35],
      ['M141 93Q158 103 169 121', 172, 5.65, 85],
      ['M233 30C227 49 216 73 206 94C221 101 242 116 257 128', 309, 6.15, 44],
      ['M251 60C248 85 235 120 199 140', 256, 5.95, 40],
      ['M195 80Q228 77 268 64', 195, 5.65, 50],
      ['M272 49Q303 52 332 43C327 53 314 63 301 70', 237, 5.8, 40],
      ['M299 69C307 83 314 114 309 137Q305 153 285 138', 266, 6.1, 45],
      ['M267 98Q303 97 349 86', 259, 5.95],
    ],
  },
]

const scores = greetings.map(({ strokes, ...greeting }, index) => {
  let start = index === 0 ? 450 : 140
  const score = strokes.map(([path, duration, width, pause = 0]) => {
    const stroke = { path, width, start, duration }
    start += duration + pause
    return stroke
  })
  return { ...greeting, strokes: score, holdUntil: start + 1000 }
})

export function Greeting({ index, advance }) {
  const greeting = scores[index]
  if (!greeting) return null
  return <svg className="intro-hello" lang={greeting.language} role="img" aria-label={greeting.text} viewBox={greeting.viewBox}
    style={{ '--ink-hold': greeting.holdUntil + 'ms' }} onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === 'intro-ink-out') advance()
    }}>
    <defs>
      <linearGradient id="intro-ink" gradientUnits="userSpaceOnUse" x1="20" y1="30" x2="500" y2="160">
        <stop stopColor="var(--text)" />
        <stop offset=".44" stopColor="var(--text)" />
        <stop offset="1" stopColor="var(--muted)" />
      </linearGradient>
    </defs>
    {greeting.strokes.map(stroke => <path key={stroke.path} className="intro-pen-stroke" d={stroke.path}
      pathLength={1} fill="none" stroke="url(#intro-ink)" strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round"
      style={{ '--ink-start': stroke.start + 'ms', '--ink-time': stroke.duration + 'ms' }} />)}
  </svg>
}

export const greetingCount = scores.length
