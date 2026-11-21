import { createContext, useContext } from 'react'
import { translate } from '../shared/locale.mjs'

export const Localization = createContext({ language: 'ru', t: (message, values) => translate('ru', message, values) })
export const useLocale = () => useContext(Localization)
