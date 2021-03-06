'use babel'
import React from 'react'
import LeftNav from '../com/leftnav'
import MsgList from '../com/msg-list'
import Oneline from '../com/msg-view/oneline'
import app from '../lib/app'

export default class PrivatePosts extends React.Component {
  cursor (msg) {
    if (msg)
      return [msg.ts, false]
  }

  onMarkAllRead() {
    if (confirm('Mark all messages read. Are you sure?')) {
      app.ssb.patchwork.markAllRead('privatePosts', err => {
        if (err)
          app.issue('Failed to mark all read', err)
      })
    }
  }

  render() {
    const RightNav = props => {
      return <div className="rightnav">
        <a onClick={this.onMarkAllRead.bind(this)} href="javascript:"><i className="fa fa-envelope" /> Mark all read</a>
      </div>
    }

    return <div id="private">
      <MsgList
        ref="list"
        threads
        dateDividers
        composer composerProps={{ isPublic: false }}
        ListItem={Oneline} listItemProps={{ userPic: true }}
        LeftNav={LeftNav} leftNavProps={{location: this.props.location}}
        RightNav={RightNav}
        live={{ gt: [Date.now(), null] }}
        emptyMsg="You have no private messages."
        source={app.ssb.patchwork.createPrivatePostStream}
        cursor={this.cursor} />
    </div>
  }
}
