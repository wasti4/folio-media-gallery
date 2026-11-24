import { Check, ChevronDown, Folder, FolderInput, FolderPlus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useLocale } from './localization.jsx'
import { IconButton, Menu, MenuItem } from './ui.jsx'

export function SelectionDock({ count, total, selectAll, openFolders, edit, remove, close, working, menuOpen }) {
  const { t, language } = useLocale()
  return <div className="selection-dock" role="group" aria-label={t('Действия с выбранными фото')} aria-busy={Boolean(working)}>
    <span className="selection-count" aria-live="polite">
      <span key={count}>{t('Выбрано {count}', { count: new Intl.NumberFormat(language).format(count) })}</span>
    </span>
    <button type="button" className="selection-all" disabled={Boolean(working) || !total} onClick={selectAll}>
      {t(count === total && total ? 'Снять выбор' : 'Выбрать все')}
    </button>
    <span className="selection-divider" aria-hidden="true" />
    <button type="button" className="selection-folder" aria-label={t('Переместить в папку')} aria-haspopup="menu"
      aria-expanded={menuOpen} disabled={!count || Boolean(working)} data-popup-trigger data-photo-target="folder" onClick={openFolders}>
      <FolderInput size={17} />
      <span>{working?.name || t('В папку')}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    {edit && <IconButton icon={SlidersHorizontal} label={t('Править выбранные фото')} className="selection-edit" size={17}
      disabled={!count || Boolean(working)} onClick={edit} />}
    <IconButton icon={Trash2} label={t('Удалить выбранные фото')} className="selection-trash" size={17}
      disabled={!count || Boolean(working)} data-photo-target="trash" onClick={remove} />
    <IconButton icon={X} label={t('Завершить выбор')} className="selection-close" size={16} disabled={Boolean(working)} onClick={close} />
  </div>
}

export function PhotoFolderMenu({ anchor, onClose, folders, choose, create }) {
  const { t } = useLocale()
  const physical = folders.filter(folder => folder.kind === 'physical')
  const collections = folders.filter(folder => folder.kind === 'collection')
  return <Menu anchor={anchor} onClose={onClose} placement="up" className="photo-folder-menu">
    <MenuItem icon={FolderPlus} onClick={create}>{t('Новая папка…')}</MenuItem>
    {physical.length > 0 && <>
      <div className="menu-divider" role="separator" />
      <div className="menu-heading">{t('Папки')}</div>
      {physical.map(folder => <MenuItem icon={Folder} key={folder.id} title={folder.name} onClick={() => choose(folder)}>{folder.name}</MenuItem>)}
    </>}
    {collections.length > 0 && <>
      <div className="menu-divider" role="separator" />
      <div className="menu-heading">{t('Подборки')}</div>
      {collections.map(folder => <MenuItem icon={Check} key={folder.id} title={folder.name} onClick={() => choose(folder)}>{folder.name}</MenuItem>)}
    </>}
  </Menu>
}
