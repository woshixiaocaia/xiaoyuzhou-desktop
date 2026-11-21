import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  officialAuthLogout,
  officialAuthPoll,
  officialAuthStart,
  officialAuthStatus,
  type OfficialStatusKind,
  type OfficialUser,
} from '@/lib/desktop'

/**
 * 官方账号的登录状态机。
 *
 * 这里**只保存「登录到了什么状态」**，不保存任何凭据——
 * access / refresh 之类的东西全程留在主进程，页面拿不到也请求不到。
 *
 * 状态流转：
 *   idle → creating → waiting → scanned → authorized
 *                  ↘ expired（二维码过期，可重新生成）
 *                  ↘ error（网络/接口/存储失败）
 */
export type AccountPhase =
  | 'idle'
  | 'checking'
  | 'creating'
  | 'waiting'
  | 'scanned'
  | 'authorized'
  | 'expired'
  | 'error'

/** 轮询间隔：官方二维码有效期通常几十秒，2 秒一次足够灵敏也不至于过密 */
const POLL_INTERVAL_MS = 2000

/**
 * 纯映射：把官方返回的扫码状态翻译成界面阶段。
 * 抽成导出函数是为了能离线测试（不需要真的开定时器轮询）。
 */
export function phaseForQrStatus(status: OfficialStatusKind): AccountPhase {
  if (status === 'CONFIRMED') return 'authorized'
  if (status === 'EXPIRED') return 'expired'
  if (status === 'SCANNED') return 'scanned'
  return 'waiting'
}

export const useAccountStore = defineStore('account', () => {
  const phase = ref<AccountPhase>('idle')
  const user = ref<OfficialUser | null>(null)
  const qrUrl = ref('')
  const qrId = ref('')
  const errorMessage = ref('')
  /** 系统是否支持加密存储；false 时提示用户「本机无法保存登录状态」 */
  const storageAvailable = ref(true)

  /** 轮询代次：取消/重新登录时代次 +1，旧的回调看到不一致就自行退出 */
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const isLoggedIn = computed(() => phase.value === 'authorized')
  const isBusy = computed(
    () => phase.value === 'creating' || phase.value === 'waiting' || phase.value === 'scanned',
  )
  const nickname = computed(() => user.value?.nickname ?? '')

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function stopPolling(): void {
    epoch += 1
    clearTimer()
  }

  function resetQr(): void {
    qrId.value = ''
    qrUrl.value = ''
  }

  /** 应用启动时恢复登录状态（凭据在主进程里解密） */
  async function restore(): Promise<void> {
    phase.value = 'checking'
    errorMessage.value = ''
    const result = await officialAuthStatus()
    if (!result.ok) {
      phase.value = 'error'
      errorMessage.value = result.message
      return
    }
    storageAvailable.value = result.storageAvailable
    if (result.loggedIn) {
      user.value = result.user
      phase.value = 'authorized'
    } else {
      user.value = null
      phase.value = 'idle'
    }
  }

  /** 开始扫码登录：拿二维码 → 开始轮询 */
  async function startLogin(): Promise<void> {
    stopPolling()
    const current = epoch
    resetQr()
    errorMessage.value = ''
    phase.value = 'creating'

    const started = await officialAuthStart()
    if (current !== epoch) return
    if (!started.ok) {
      phase.value = 'error'
      errorMessage.value = started.message
      return
    }
    qrId.value = started.id
    qrUrl.value = started.url
    phase.value = 'waiting'
    schedulePoll(epoch)
  }

  function schedulePoll(current: number): void {
    clearTimer()
    timer = setTimeout(() => {
      void pollOnce(current)
    }, POLL_INTERVAL_MS)
  }

  async function pollOnce(current: number): Promise<void> {
    if (current !== epoch) return
    const id = qrId.value
    if (id === '') return

    const result = await officialAuthPoll(id)
    if (current !== epoch) return

    if (!result.ok) {
      // 网络抖动不打断流程，继续轮询；其它错误直接停下并提示
      if (result.code === 'NETWORK' || result.code === 'TIMEOUT' || result.code === 'IPC_FAILED') {
        schedulePoll(current)
        return
      }
      phase.value = 'error'
      errorMessage.value = result.message
      return
    }

    applyStatus(result.status, result.user, result.storage)
    if (result.status === 'CONFIRMED') return
    if (result.status === 'EXPIRED') return
    schedulePoll(current)
  }

  function applyStatus(status: OfficialStatusKind, nextUser: OfficialUser | null, storage: string): void {
    if (status === 'CONFIRMED') {
      user.value = nextUser
      phase.value = 'authorized'
      resetQr()
      stopPolling()
      if (storage === 'STORAGE_UNAVAILABLE') {
        storageAvailable.value = false
        errorMessage.value = '本机不支持安全存储，本次登录在应用重启后会失效'
      } else if (storage !== 'ok') {
        errorMessage.value = '登录状态未能保存，重启后可能需要重新登录'
      }
      return
    }
    if (status === 'EXPIRED') {
      resetQr()
      phase.value = phaseForQrStatus(status)
      stopPolling()
      return
    }
    phase.value = phaseForQrStatus(status)
  }

  /** 用户主动取消扫码 */
  function cancel(): void {
    stopPolling()
    resetQr()
    phase.value = 'idle'
    errorMessage.value = ''
  }

  /** 退出登录：清空主进程里的凭据，并重置本地状态 */
  async function logout(): Promise<void> {
    stopPolling()
    const result = await officialAuthLogout()
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    user.value = null
    resetQr()
    errorMessage.value = ''
    phase.value = 'idle'
  }

  function invalidate(): void {
    stopPolling()
    resetQr()
    user.value = null
    phase.value = 'idle'
    errorMessage.value = '登录状态已失效，请重新扫码登录'
  }

  return {
    invalidate,
    phase,
    user,
    qrUrl,
    qrId,
    errorMessage,
    storageAvailable,
    isLoggedIn,
    isBusy,
    nickname,
    restore,
    startLogin,
    cancel,
    logout,
  }
})
