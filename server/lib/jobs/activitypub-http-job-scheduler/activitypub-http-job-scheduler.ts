import { JobCategory } from '../../../../shared'
import { buildSignedActivity, logger } from '../../../helpers'
import { ACTIVITY_PUB } from '../../../initializers'
import { ActorModel } from '../../../models/activitypub/actor'
import { JobHandler, JobScheduler } from '../job-scheduler'

import * as activitypubHttpBroadcastHandler from './activitypub-http-broadcast-handler'
import * as activitypubHttpFetcherHandler from './activitypub-http-fetcher-handler'
import * as activitypubHttpUnicastHandler from './activitypub-http-unicast-handler'

type ActivityPubHttpPayload = {
  uris: string[]
  signatureActorId?: number
  body?: any
  attemptNumber?: number
}

const jobHandlers: { [ handlerName: string ]: JobHandler<ActivityPubHttpPayload, void> } = {
  activitypubHttpBroadcastHandler,
  activitypubHttpUnicastHandler,
  activitypubHttpFetcherHandler
}
const jobCategory: JobCategory = 'activitypub-http'

const activitypubHttpJobScheduler = new JobScheduler(jobCategory, jobHandlers)

function maybeRetryRequestLater (err: Error, payload: ActivityPubHttpPayload, uri: string) {
  logger.warn('Cannot make request to %s.', uri, err)

  let attemptNumber = payload.attemptNumber || 1
  attemptNumber += 1

  if (attemptNumber < ACTIVITY_PUB.MAX_HTTP_ATTEMPT) {
    logger.debug('Retrying request to %s (attempt %d/%d).', uri, attemptNumber, ACTIVITY_PUB.MAX_HTTP_ATTEMPT, err)

    const newPayload = Object.assign(payload, {
      uris: [ uri ],
      attemptNumber
    })
    return activitypubHttpJobScheduler.createJob(undefined, 'activitypubHttpUnicastHandler', newPayload)
  }
}

async function computeBody (payload: ActivityPubHttpPayload) {
  let body = payload.body

  if (payload.signatureActorId) {
    const actorSignature = await ActorModel.load(payload.signatureActorId)
    if (!actorSignature) throw new Error('Unknown signature account id.')
    body = await buildSignedActivity(actorSignature, payload.body)
  }

  return body
}

export {
  ActivityPubHttpPayload,
  activitypubHttpJobScheduler,
  maybeRetryRequestLater,
  computeBody
}
