// utils/cloudflare.js
const fetch = require('node-fetch')

class CloudflareService {
  constructor() {
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`
  }

  async getUploadUrl() {
    const response = await fetch(`${this.baseUrl}/direct_upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        maxDurationSeconds: 3600,
        allowedOrigins: [process.env.FRONTEND_URL],
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to get upload URL')
    }

    const data = await response.json()
    return {
      uploadUrl: data.result.uploadURL,
      videoId: data.result.uid,
    }
  }

  async deleteVideo(videoId) {
    const response = await fetch(`${this.baseUrl}/${videoId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    })

    if (!response.ok) {
      throw new Error('Failed to delete video')
    }

    return true
  }

  async getVideoDetails(videoId) {
    const response = await fetch(`${this.baseUrl}/${videoId}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    })

    if (!response.ok) {
      throw new Error('Failed to get video details')
    }

    const data = await response.json()
    return {
      status: data.result.status,
      duration: data.result.duration,
      thumbnail: data.result.thumbnail,
      playbackUrl: data.result.playback.hls,
    }
  }
}

module.exports = new CloudflareService()
