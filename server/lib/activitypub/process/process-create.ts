import * as Bluebird from 'bluebird'
import { ActivityCreate, VideoTorrentObject } from '../../../../shared'
import { DislikeObject, VideoAbuseObject, ViewObject } from '../../../../shared/models/activitypub/objects'
import { VideoRateType } from '../../../../shared/models/videos'
import { logger, retryTransactionWrapper } from '../../../helpers'
import { sequelizeTypescript } from '../../../initializers'
import { AccountVideoRateModel } from '../../../models/account/account-video-rate'
import { ActorModel } from '../../../models/activitypub/actor'
import { TagModel } from '../../../models/video/tag'
import { VideoModel } from '../../../models/video/video'
import { VideoAbuseModel } from '../../../models/video/video-abuse'
import { VideoFileModel } from '../../../models/video/video-file'
import { getOrCreateActorAndServerAndModel } from '../actor'
import { forwardActivity } from '../send/misc'
import { generateThumbnailFromUrl } from '../videos'
import { addVideoShares, videoActivityObjectToDBAttributes, videoFileActivityUrlToDBAttributes } from './misc'

async function processCreateActivity (activity: ActivityCreate) {
  const activityObject = activity.object
  const activityType = activityObject.type
  const actor = await getOrCreateActorAndServerAndModel(activity.actor)

  if (activityType === 'View') {
    return processCreateView(actor, activity)
  } else if (activityType === 'Dislike') {
    return processCreateDislike(actor, activity)
  } else if (activityType === 'Video') {
    return processCreateVideo(actor, activity)
  } else if (activityType === 'Flag') {
    return processCreateVideoAbuse(actor, activityObject as VideoAbuseObject)
  }

  logger.warn('Unknown activity object type %s when creating activity.', activityType, { activity: activity.id })
  return Promise.resolve(undefined)
}

// ---------------------------------------------------------------------------

export {
  processCreateActivity
}

// ---------------------------------------------------------------------------

async function processCreateVideo (
  actor: ActorModel,
  activity: ActivityCreate
) {
  const videoToCreateData = activity.object as VideoTorrentObject

  const channel = videoToCreateData.attributedTo.find(a => a.type === 'Group')
  if (!channel) throw new Error('Cannot find associated video channel to video ' + videoToCreateData.url)

  const channelActor = await getOrCreateActorAndServerAndModel(channel.id)

  const options = {
    arguments: [ actor, activity, videoToCreateData, channelActor ],
    errorMessage: 'Cannot insert the remote video with many retries.'
  }

  const video = await retryTransactionWrapper(createRemoteVideo, options)

  // Process outside the transaction because we could fetch remote data
  if (videoToCreateData.likes && Array.isArray(videoToCreateData.likes.orderedItems)) {
    await createRates(videoToCreateData.likes.orderedItems, video, 'like')
  }

  if (videoToCreateData.dislikes && Array.isArray(videoToCreateData.dislikes.orderedItems)) {
    await createRates(videoToCreateData.dislikes.orderedItems, video, 'dislike')
  }

  if (videoToCreateData.shares && Array.isArray(videoToCreateData.shares.orderedItems)) {
    await addVideoShares(video, videoToCreateData.shares.orderedItems)
  }

  return video
}

function createRemoteVideo (
  account: ActorModel,
  activity: ActivityCreate,
  videoToCreateData: VideoTorrentObject,
  channelActor: ActorModel
) {
  logger.debug('Adding remote video %s.', videoToCreateData.id)

  return sequelizeTypescript.transaction(async t => {
    const sequelizeOptions = {
      transaction: t
    }
    const videoFromDatabase = await VideoModel.loadByUUIDOrURL(videoToCreateData.uuid, videoToCreateData.id, t)
    if (videoFromDatabase) return videoFromDatabase

    const videoData = await videoActivityObjectToDBAttributes(channelActor.VideoChannel, videoToCreateData, activity.to, activity.cc)
    const video = VideoModel.build(videoData)

    // Don't block on request
    generateThumbnailFromUrl(video, videoToCreateData.icon)
      .catch(err => logger.warn('Cannot generate thumbnail of %s.', videoToCreateData.id, err))

    const videoCreated = await video.save(sequelizeOptions)

    const videoFileAttributes = videoFileActivityUrlToDBAttributes(videoCreated, videoToCreateData)
    if (videoFileAttributes.length === 0) {
      throw new Error('Cannot find valid files for video %s ' + videoToCreateData.url)
    }

    const tasks: Bluebird<any>[] = videoFileAttributes.map(f => VideoFileModel.create(f, { transaction: t }))
    await Promise.all(tasks)

    const tags = videoToCreateData.tag.map(t => t.name)
    const tagInstances = await TagModel.findOrCreateTags(tags, t)
    await videoCreated.$set('Tags', tagInstances, sequelizeOptions)

    logger.info('Remote video with uuid %s inserted.', videoToCreateData.uuid)

    return videoCreated
  })
}

async function createRates (actorUrls: string[], video: VideoModel, rate: VideoRateType) {
  let rateCounts = 0
  const tasks: Bluebird<any>[] = []

  for (const actorUrl of actorUrls) {
    const actor = await getOrCreateActorAndServerAndModel(actorUrl)
    const p = AccountVideoRateModel
      .create({
        videoId: video.id,
        accountId: actor.Account.id,
        type: rate
      })
      .then(() => rateCounts += 1)

    tasks.push(p)
  }

  await Promise.all(tasks)

  logger.info('Adding %d %s to video %s.', rateCounts, rate, video.uuid)

  // This is "likes" and "dislikes"
  await video.increment(rate + 's', { by: rateCounts })

  return
}

async function processCreateDislike (byActor: ActorModel, activity: ActivityCreate) {
  const options = {
    arguments: [ byActor, activity ],
    errorMessage: 'Cannot dislike the video with many retries.'
  }

  return retryTransactionWrapper(createVideoDislike, options)
}

function createVideoDislike (byActor: ActorModel, activity: ActivityCreate) {
  const dislike = activity.object as DislikeObject
  const byAccount = byActor.Account

  if (!byAccount) throw new Error('Cannot create dislike with the non account actor ' + byActor.url)

  return sequelizeTypescript.transaction(async t => {
    const video = await VideoModel.loadByUrlAndPopulateAccount(dislike.object, t)
    if (!video) throw new Error('Unknown video ' + dislike.object)

    const rate = {
      type: 'dislike' as 'dislike',
      videoId: video.id,
      accountId: byAccount.id
    }
    const [ , created ] = await AccountVideoRateModel.findOrCreate({
      where: rate,
      defaults: rate,
      transaction: t
    })
    if (created === true) await video.increment('dislikes', { transaction: t })

    if (video.isOwned() && created === true) {
      // Don't resend the activity to the sender
      const exceptions = [ byActor ]
      await forwardActivity(activity, t, exceptions)
    }
  })
}

async function processCreateView (byAccount: ActorModel, activity: ActivityCreate) {
  const view = activity.object as ViewObject

  const video = await VideoModel.loadByUrlAndPopulateAccount(view.object)

  if (!video) throw new Error('Unknown video ' + view.object)

  const account = await ActorModel.loadByUrl(view.actor)
  if (!account) throw new Error('Unknown account ' + view.actor)

  await video.increment('views')

  if (video.isOwned()) {
    // Don't resend the activity to the sender
    const exceptions = [ byAccount ]
    await forwardActivity(activity, undefined, exceptions)
  }
}

function processCreateVideoAbuse (actor: ActorModel, videoAbuseToCreateData: VideoAbuseObject) {
  const options = {
    arguments: [ actor, videoAbuseToCreateData ],
    errorMessage: 'Cannot insert the remote video abuse with many retries.'
  }

  return retryTransactionWrapper(addRemoteVideoAbuse, options)
}

function addRemoteVideoAbuse (actor: ActorModel, videoAbuseToCreateData: VideoAbuseObject) {
  logger.debug('Reporting remote abuse for video %s.', videoAbuseToCreateData.object)

  const account = actor.Account
  if (!account) throw new Error('Cannot create dislike with the non account actor ' + actor.url)

  return sequelizeTypescript.transaction(async t => {
    const video = await VideoModel.loadByUrlAndPopulateAccount(videoAbuseToCreateData.object, t)
    if (!video) {
      logger.warn('Unknown video %s for remote video abuse.', videoAbuseToCreateData.object)
      return undefined
    }

    const videoAbuseData = {
      reporterAccountId: account.id,
      reason: videoAbuseToCreateData.content,
      videoId: video.id
    }

    await VideoAbuseModel.create(videoAbuseData)

    logger.info('Remote abuse for video uuid %s created', videoAbuseToCreateData.object)
  })
}
