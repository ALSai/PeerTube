import * as express from 'express'
import { query } from 'express-validator/check'
import { logger } from '../../helpers'
import { isWebfingerResourceValid } from '../../helpers/custom-validators/webfinger'
import { ActorModel } from '../../models/activitypub/actor'
import { areValidationErrors } from './utils'

const webfingerValidator = [
  query('resource').custom(isWebfingerResourceValid).withMessage('Should have a valid webfinger resource'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking webfinger parameters', { parameters: req.query })

    if (areValidationErrors(req, res)) return

    // Remove 'acct:' from the beginning of the string
    const nameWithHost = req.query.resource.substr(5)
    const [ name ] = nameWithHost.split('@')

    const actor = await ActorModel.loadLocalByName(name)
    if (!actor) {
      return res.status(404)
        .send({ error: 'Actor not found' })
        .end()
    }

    res.locals.actor = actor
    return next()
  }
]

// ---------------------------------------------------------------------------

export {
  webfingerValidator
}
