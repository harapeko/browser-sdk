import {
  combine,
  Configuration,
  Context,
  createErrorFilter,
  ErrorFilter,
  isEmptyObject,
  limitModification,
  timeStampNow,
  currentDrift,
  display,
  addMonitoringMessage,
  relativeNow,
  BeforeSendCallback,
} from '@datadog/browser-core'
import { RumEventDomainContext } from '../domainContext.types'
import {
  CommonContext,
  RawRumErrorEvent,
  RawRumEvent,
  RawRumLongTaskEvent,
  RawRumResourceEvent,
  RumContext,
  RumEventType,
  User,
} from '../rawRumEvent.types'
import { RumEvent } from '../rumEvent.types'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import { ParentContexts } from './parentContexts'
import { RumSession, RumSessionPlan } from './rumSession'

export interface BrowserWindow extends Window {
  _DATADOG_SYNTHETICS_PUBLIC_ID?: string
  _DATADOG_SYNTHETICS_RESULT_ID?: string
}

enum SessionType {
  SYNTHETICS = 'synthetics',
  USER = 'user',
}

const VIEW_EVENTS_MODIFIABLE_FIELD_PATHS = [
  // Fields with sensitive data
  'view.url',
  'view.referrer',
  'action.target.name',
  'error.message',
  'error.stack',
  'error.resource.url',
  'resource.url',
]

const OTHER_EVENTS_MODIFIABLE_FIELD_PATHS = [
  ...VIEW_EVENTS_MODIFIABLE_FIELD_PATHS,
  // User-customizable field
  'context',
]

type Mutable<T> = { -readonly [P in keyof T]: T[P] }

export function startRumAssembly(
  applicationId: string,
  configuration: Configuration,
  lifeCycle: LifeCycle,
  session: RumSession,
  parentContexts: ParentContexts,
  getCommonContext: () => CommonContext
) {
  const errorFilter = createErrorFilter(configuration, (error) => {
    lifeCycle.notify(LifeCycleEventType.RAW_ERROR_COLLECTED, { error })
  })

  lifeCycle.subscribe(
    LifeCycleEventType.RAW_RUM_EVENT_COLLECTED,
    ({ startTime, rawRumEvent, domainContext, savedCommonContext, customerContext }) => {
      const viewContext = parentContexts.findView(startTime)
      if (session.isTracked() && viewContext && viewContext.session.id === session.getId()) {
        const actionContext = parentContexts.findAction(startTime)
        const commonContext = savedCommonContext || getCommonContext()
        const rumContext: RumContext = {
          _dd: {
            format_version: 2,
            drift: currentDrift(),
            session: {
              plan: session.hasReplayPlan() ? RumSessionPlan.REPLAY : RumSessionPlan.LITE,
            },
          },
          application: {
            id: applicationId,
          },
          date: timeStampNow(),
          service: configuration.service,
          session: {
            // must be computed on each event because synthetics instrumentation can be done after sdk execution
            type: getSessionType(),
          },
          synthetics: getSyntheticsContext(),
        }
        let serverRumEvent = (needToAssembleWithAction(rawRumEvent)
          ? combine(rumContext, viewContext, actionContext, rawRumEvent)
          : combine(rumContext, viewContext, rawRumEvent)) as RumEvent & Context

        if (rawRumEvent.type !== RumEventType.VIEW) {
          serverRumEvent = combine(serverRumEvent, parentContexts.findViewUrl(startTime))
        }

        serverRumEvent.context = combine(commonContext.context, customerContext)

        if (!('has_replay' in serverRumEvent.session)) {
          ;(serverRumEvent.session as Mutable<RumEvent['session']>).has_replay = commonContext.hasReplay
        }

        if (!isEmptyObject(commonContext.user)) {
          ;(serverRumEvent.usr as Mutable<RumEvent['usr']>) = commonContext.user as User & Context
        }
        if (shouldSend(serverRumEvent, configuration.beforeSend, domainContext, errorFilter)) {
          if (isEmptyObject(serverRumEvent.context)) {
            delete serverRumEvent.context
          }
          if (typeof serverRumEvent.date !== 'number') {
            addMonitoringMessage('invalid date', {
              debug: {
                eventType: serverRumEvent.type,
                eventTimeStamp: serverRumEvent.date,
                eventRelativeTime: Math.round(startTime),
                timeStampNow: timeStampNow(),
                relativeNow: Math.round(relativeNow()),
                drift: currentDrift(),
              },
            })
          }
          lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, serverRumEvent)
        }
      }
    }
  )
}

function shouldSend(
  event: RumEvent & Context,
  beforeSend: BeforeSendCallback | undefined,
  domainContext: RumEventDomainContext,
  errorFilter: ErrorFilter
) {
  if (beforeSend) {
    const result = limitModification(
      event,
      event.type === RumEventType.VIEW ? VIEW_EVENTS_MODIFIABLE_FIELD_PATHS : OTHER_EVENTS_MODIFIABLE_FIELD_PATHS,
      (event) => beforeSend(event, domainContext)
    )
    if (result === false && event.type !== RumEventType.VIEW) {
      return false
    }
    if (result === false) {
      display.warn("Can't dismiss view events using beforeSend!")
    }
  }
  if (event.type === RumEventType.ERROR) {
    return !errorFilter.isLimitReached()
  }
  return true
}

function needToAssembleWithAction(
  event: RawRumEvent
): event is RawRumErrorEvent | RawRumResourceEvent | RawRumLongTaskEvent {
  return [RumEventType.ERROR, RumEventType.RESOURCE, RumEventType.LONG_TASK].indexOf(event.type) !== -1
}

function getSessionType() {
  return navigator.userAgent.indexOf('DatadogSynthetics') === -1 && !getSyntheticsContext()
    ? SessionType.USER
    : SessionType.SYNTHETICS
}

function getSyntheticsContext() {
  const testId = (window as BrowserWindow)._DATADOG_SYNTHETICS_PUBLIC_ID
  const resultId = (window as BrowserWindow)._DATADOG_SYNTHETICS_RESULT_ID

  if (typeof testId === 'string' && typeof resultId === 'string') {
    return {
      test_id: testId,
      result_id: resultId,
    }
  }
}
