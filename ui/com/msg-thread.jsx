'use babel'
import React from 'react'
import { Link } from 'react-router'
import ReactCSSTransitionGroup from 'react-addons-css-transition-group'
import mlib from 'ssb-msgs'
import schemas from 'ssb-msg-schemas'
import threadlib from 'patchwork-threads'
import pull from 'pull-stream'
import { UserLinks } from './index'
import ResponsiveElement from './responsive-element'
import Card from './msg-view/card'
import { isaReplyTo, relationsTo } from '../lib/msg-relation'
import Composer from './composer'
import app from '../lib/app'
import u from '../lib/util'

class BookmarkBtn extends React.Component {
  render() {
    const b = this.props.isBookmarked
    const title = 'Bookmark'+(b?'ed':'')
    const hint = (b?'Remove this message from your bookmarks':'Add this message to your bookmarks')
    return <a className={'hint--bottom '+(b?' selected':'')} data-hint={hint} onClick={this.props.onClick} title={title}>
        <i className={'fa fa-bookmark'+(b?'':'-o')} /> {title}
    </a>
  }
}

class UnreadBtn extends React.Component {
  constructor(props) {
    super(props)
    this.state={marked: false}
  }
  onClick() {
    if (this.state.marked)
      return
    this.setState({marked: true})
    this.props.onClick()
  }
  render() {
    const m = this.state.marked
    return <a onClick={this.onClick.bind(this)} className="hint--bottom" data-hint="Close this thread and leave it unread">
      <i className={"fa fa-envelope"+(m?'':'-o')} /> Mark{m?'ed':''} Unread
    </a>
  }
}
            

export default class Thread extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      thread: null,
      isLoading: true,
      isHidingHistory: true,
      msgs: []
    }
    this.liveStream = null
  }

  // helper to do setup on thread-change
  constructState(id) {
    // only construct for new threads
    if (this.state.thread && id === this.state.thread.key)
      return

    // load thread, but defer computing any knowledge
    threadlib.getPostThread(app.ssb, id, { isRead: false, isBookmarked: false, mentions: false, votes: false }, (err, thread) => {
      if (err)
        return app.issue('Failed to Load Message', err, 'This happened in msg-list componentDidMount')

      // compile thread votes
      threadlib.compileThreadVotes(thread)

      // flatten *before* fetching info on replies, to make sure that info is attached to the right msg object
      var flattenedMsgs = threadlib.flattenThread(thread)
      thread.related = flattenedMsgs.slice(flattenedMsgs.indexOf(thread) + 1) // skip past the root
      threadlib.fetchThreadData(app.ssb, thread, { isRead: true, isBookmarked: true, mentions: true }, (err, thread) => {
        if (err)
          return app.issue('Failed to Load Message', err, 'This happened in msg-list componentDidMount')

        // note which messages start out unread, so they stay collapsed during this render
        flattenedMsgs.forEach(m => m._isRead = m.isRead)

        // now set state
        this.setState({
          isLoading: false,
          thread: thread,
          msgs: flattenedMsgs,
          isReplying: (this.state.thread && thread.key === this.state.thread.key) ? this.state.isReplying : false
        })

        // mark read
        if (thread.hasUnread) {
          threadlib.markThreadRead(app.ssb, thread, (err) => {
            if (err)
              return app.minorIssue('Failed to mark thread as read', err)
            this.setState({ thread: thread })
          })
        }

        // listen for new replies
        if (this.props.live) {
          if (this.liveStream)
            this.liveStream(true, ()=>{}) // abort existing livestream

          pull(
            // listen for all new messages
            (this.liveStream = app.ssb.createLogStream({ live: true, gt: Date.now() })),
            pull.filter(obj => !obj.sync), // filter out the sync obj
            pull.asyncMap((msg, cb) => threadlib.decryptThread(app.ssb, msg, cb)),
            pull.drain((msg) => {
              if (!this.state.thread)
                return
              
              var c = msg.value.content
              var rels = mlib.relationsTo(msg, this.state.thread)
              // reply post to this thread?
              if (c.type == 'post' && (rels.indexOf('root') >= 0 || rels.indexOf('branch') >= 0)) {
                // add to thread and flatlist
                this.state.msgs.push(msg)
                this.state.thread.related = (this.state.thread.related||[]).concat(msg)
                this.setState({ thread: this.state.thread, msgs: this.state.msgs })

                // mark read
                thread.hasUnread = true
                threadlib.markThreadRead(app.ssb, this.state.thread, err => {
                  if (err)
                    app.minorIssue('Failed to mark live-streamed reply as read', err)
                })
              }
            })
          )
        }
      })
    })
  }
  componentDidMount() {
    this.constructState(this.props.id)
    this.props.onDidMount && this.props.onDidMount()
  }
  componentWillReceiveProps(newProps) {
    this.constructState(newProps.id)
  }
  componentDidUpdate() {
    this.props.onDidMount && this.props.onDidMount()    
  }
  componentWillUnmount() {
    // abort the livestream
    if (this.liveStream)
      this.liveStream(true, ()=>{})
  }

  getScrollTop() {
    // helper to bring the thread into view
    const container = this.refs.container
    if (!container)
      return false
    return container.offsetTop
  }

  onClose() {
    this.props.onClose && this.props.onClose()
  }

  onShowHistory() {
    this.setState({ isHidingHistory: false })
  }

  onMarkUnread() {
    // mark unread in db
    let thread = this.state.thread
    app.ssb.patchwork.markUnread(thread.key, err => {
      if (err)
        return app.minorIssue('Failed to mark unread', err, 'Happened in onMarkUnread of MsgThread')

      // re-render
      thread.isRead = false
      thread.hasUnread = true
      this.setState(this.state)
    })
  }

  onToggleBookmark(e) {
    e.preventDefault()
    e.stopPropagation()

    // toggle in the DB
    let thread = this.state.thread
    app.ssb.patchwork.toggleBookmark(thread.key, (err, isBookmarked) => {
      if (err)
        return app.issue('Failed to toggle bookmark', err, 'Happened in onToggleBookmark of MsgThread')

      // re-render
      thread.isBookmarked = isBookmarked
      this.setState(this.state)
    })
  }

  onToggleStar(msg) {
    // get current state
    msg.votes = msg.votes || {}
    let oldVote = msg.votes[app.user.id]
    let newVote = (oldVote === 1) ? 0 : 1

    // publish new message
    var voteMsg = schemas.vote(msg.key, newVote)
    let done = (err) => {
      if (err)
        return app.issue('Failed to publish vote', err, 'Happened in onToggleStar of MsgThread')

      // re-render
      msg.votes[app.user.id] = newVote
      this.setState(this.state)
    }
    if (msg.plaintext)
      app.ssb.publish(voteMsg, done)
    else {
      let recps = mlib.links(msg.value.content.recps).map(l => l.link)
      app.ssb.private.publish(voteMsg, recps, done)
    }
  }

  onFlag(msg, reason) {
    if (!reason)
      throw new Error('reason is required')

    // publish new message
    const voteMsg = (reason === 'unflag') // special case
      ? schemas.vote(msg.key, 0)
      : schemas.vote(msg.key, -1, reason)
    let done = (err) => {
      if (err)
        return app.issue('Failed to publish flag', err, 'Happened in onFlag of MsgThread')

      // re-render
      msg.votes = msg.votes || {}
      msg.votes[app.user.id] = (reason === 'unflag') ? 0 : -1
      this.setState(this.state)
    }
    if (msg.plaintext)
      app.ssb.publish(voteMsg, done)
    else {
      let recps = mlib.links(msg.value.content.recps).map(l => l.link)
      app.ssb.private.publish(voteMsg, recps, done)
    }
  }

  onSend(msg) {
    if (this.props.onNewReply)
      this.props.onNewReply(msg)
  }

  openMsg(id) {
    app.history.pushState(null, '/msg/'+encodeURIComponent(id))
  }

  onSelectRoot(e) {
    e.preventDefault()
    e.stopPropagation()
    const thread = this.state.thread
    const threadRoot = mlib.link(thread.value.content.root, 'msg')
    this.openMsg(threadRoot.link)
  }

  render() {
    const thread = this.state.thread
    const threadRoot = thread && mlib.link(thread.value.content.root, 'msg')
    const canMarkUnread = thread && (thread.isBookmarked || !thread.plaintext)
    const isPublic = (thread && thread.plaintext)
    const authorName = thread && u.getName(thread.value.author)
    const channel = thread && thread.value.content.channel
    const recps = thread && mlib.links(thread.value.content.recps, 'feed')

    // hide old unread messages
    // (only do it for the first unbroken chain of unreads)
    var msgs = [].concat(this.state.msgs)
    var numOldHidden = 0
    if (this.state.isHidingHistory) {
      let startOld = msgs.indexOf(thread) // start at the root (which isnt always first)
      if (startOld !== -1) {
        startOld += 1 // always include the root
        for (let i=startOld; i < msgs.length - 1; i++) {
          if (msgs[i]._isRead === false)
            break // found an unread, break here
          numOldHidden++
        }
        numOldHidden-- // always include the last old msg
        if (numOldHidden > 0)
          msgs.splice(startOld, numOldHidden, { isOldMsgsPlaceholder: true })
      }
    }

    return <div className="msg-thread" ref="container">
      { !thread
        ? <div style={{padding: 20, fontWeight: 300, textAlign:'center'}}>{ this.state.isLoading ? 'Loading...' : 'No thread selected.' }</div>
        : <ResponsiveElement widthStep={250}>
            <div className="flex thread-toolbar" onClick={this.onClose.bind(this)}>
              <div className="flex-fill">
                { (thread && thread.mentionsUser) ? <i className="fa fa-at"/> : '' }{' '}
                { (thread && thread.plaintext) ? '' : <i className="fa fa-lock"/> }{' '}
                { recps && recps.length
                  ? <span>To: <UserLinks ids={recps.map(r => r.link)} /></span>
                  : '' }
                { channel ? <span className="channel">in <Link to={`/public/channel/${channel}`}>#{channel}</Link></span> : ''}
              </div>
              { threadRoot
                ? <a onClick={this.onSelectRoot.bind(this)}><i className="fa fa-angle-double-up" /> Parent Thread</a>
                : '' }
              { !threadRoot && thread
                ? <BookmarkBtn onClick={this.onToggleBookmark.bind(this)} isBookmarked={thread.isBookmarked} />
                : '' }
              { thread
                ? <UnreadBtn onClick={this.onMarkUnread.bind(this)} isUnread={thread.hasUnread} />
                : '' }
            </div>
            <ReactCSSTransitionGroup component="div" className="items" transitionName="fade" transitionAppear={true} transitionAppearTimeout={500} transitionEnterTimeout={500} transitionLeaveTimeout={1}>
              { msgs.map((msg, i) => {
                if (msg.isOldMsgsPlaceholder)
                  return <div className="msg-view card-oldposts" onClick={this.onShowHistory.bind(this)}>{numOldHidden} older messages</div>

                const isLast = (i === msgs.length - 1)
                return <Card
                  key={msg.key}
                  msg={msg}
                  noReplies
                  noBookmark
                  forceRaw={this.props.forceRaw}
                  forceExpanded={isLast || !msg._isRead}
                  onSelect={()=>this.openMsg(msg.key)}
                  onToggleStar={()=>this.onToggleStar(msg)}
                  onFlag={(msg, reason)=>this.onFlag(msg, reason)} />
              }) }
              <div key="composer" className="container"><Composer key={thread.key} thread={thread} onSend={this.onSend.bind(this)} /></div>
            </ReactCSSTransitionGroup>
          </ResponsiveElement>
      }
    </div>
  }
}