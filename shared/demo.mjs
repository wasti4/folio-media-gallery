export const demoFolders = [
  { id: 'demo-travel', name: 'Путешествия', kind: 'demo' },
  { id: 'demo-motion', name: 'В движении', kind: 'demo' },
  { id: 'demo-inspire', name: 'Вдохновение', kind: 'demo' },
]

const samples = [
  ['shore', 'На краю Исландии', 'jpg', 'travel', 20],
  ['tokyo', 'Токио после дождя', 'mp4', 'motion', 20, 10],
  ['arches', 'Архитектура света', 'jpg', 'inspire', 20],
  ['dunes', 'Пески Намиба', 'jpg', 'travel', 19],
  ['wave', 'Дыхание океана', 'gif', 'motion', 19],
  ['forest', 'Первый свет', 'jpg', 'inspire', 19],
  ['lake', 'Ледниковое озеро', 'jpg', 'travel', 18],
  ['sunset', 'Последний луч', 'jpg', 'inspire', 18],
  ['tram', 'Вечерний трамвай', 'jpg', 'inspire', 17],
  ['dolomites', 'За гранью тишины', 'mp4', 'travel', 16, 14],
]

export const demoItems = samples.map(([slug, name, ext, folder, day, duration], index) => ({
  id: 'demo-' + slug,
  slug,
  name,
  filename: slug + '.' + ext,
  poster: slug + '.jpg',
  kind: ext === 'jpg' ? 'photo' : ext === 'gif' ? 'gif' : 'video',
  ext,
  duration,
  folderId: 'demo-' + folder,
  folderName: demoFolders.find(item => item.id === 'demo-' + folder).name,
  modifiedAt: Date.UTC(2026, 10, day, 6, 59 - index),
  demo: true,
}))
