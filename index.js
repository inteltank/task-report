require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const moment = require('moment');
const express = require('express'); // 追加

const TODOIST_API_TOKEN = process.env.TODOIST_API_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const POST_CHANNEL = process.env.SLACK_POST_CHANNEL;

const app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET
});

// Expressアプリの作成
const server = express();
const port = process.env.PORT || 3000;

// Function to fetch tasks from Todoist
async function fetchTasks() {
    try {
        const response = await axios.get('https://api.todoist.com/rest/v2/tasks', {
            headers: {
                Authorization: `Bearer ${TODOIST_API_TOKEN}`
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching tasks from Todoist:', error);
        return [];
    }
}

// Function to categorize tasks
function categorizeTasks(tasks) {
    const today = moment().startOf('day');
    const tomorrow = moment().add(1, 'day').startOf('day');

    // フィルタリング条件に基づいてタスクを分類
    const completedToday = tasks.filter(task => task.is_completed && moment(task.due.date).isSame(today, 'day'));
    const overdue = tasks.filter(task => !task.is_completed && task.due && moment(task.due.date).isBefore(today));
    const dueTomorrow = tasks.filter(task => !task.is_completed && task.due && moment(task.due.date).isSame(tomorrow, 'day'));

    return { completedToday, overdue, dueTomorrow };
}

// Function to format the Slack message with a button to open a modal
function formatMessage(tasks) {
    const { completedToday, overdue, dueTomorrow } = tasks;
    let text = '';

    if (completedToday.length > 0) {
        text += '*Completed Today:*\n';
        completedToday.forEach(task => {
            text += ` * ${task.content}\n`;
        });
        text += '\n';
    }

    if (overdue.length > 0) {
        text += '*Overdue Tasks:*\n';
        overdue.forEach(task => {
            text += ` * ${task.content} (Due: ${moment(task.due.date).format('YYYY-MM-DD')})\n`; // 修正: task.due.date を使用
        });
        text += '\n';
    }

    if (dueTomorrow.length > 0) {
        text += '*Tasks for Tomorrow:*\n';
        dueTomorrow.forEach(task => {
            text += ` * ${task.content}\n`;
        });
        text += '\n';
    }

    return {
        text: text || 'No tasks to display.',
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: text.trim() // 追加: 最後の余分な改行をトリム
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: 'Submit Comment'
                        },
                        action_id: 'open_comment_modal'
                    }
                ]
            }
        ]
    };
}

// Function to send tasks to Slack with interactivity
async function sendTasksToSlack() {
    const tasks = await fetchTasks();
    const categorizedTasks = categorizeTasks(tasks);
    const message = formatMessage(categorizedTasks);

    try {
        await app.client.chat.postMessage({
            channel: POST_CHANNEL, // Replace with your channel ID
            ...message
        });
    } catch (error) {
        console.error('Error sending message to Slack:', error);
    }
}

// Action handler for when the button is clicked to open a modal
app.action('open_comment_modal', async ({ ack, body, client }) => {
    await ack();

    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'submit_comment',
                private_metadata: JSON.stringify({
                    original_message_ts: body.message.ts, // 元のメッセージのタイムスタンプ
                    channel_id: body.channel.id, // メッセージが投稿されたチャンネルID
                    original_text: body.message.blocks[0].text.text // 元のメッセージのテキスト
                }),
                title: {
                    type: 'plain_text',
                    text: 'Add Comment' // 24文字以内であること
                },
                submit: {
                    type: 'plain_text',
                    text: 'Submit' // Submit ボタンのラベル
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'comment_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'comment_input',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Enter your comment here...'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Your Comment'
                        }
                    }
                ]
            }
        });
    } catch (error) {
        console.error('Error opening modal:', error);
    }
});

// View submission handler for the modal
app.view('submit_comment', async ({ ack, body, view, client }) => {
    await ack();

    const comment = view.state.values.comment_block.comment_input.value;
    const privateMetadata = JSON.parse(view.private_metadata);
    const originalMessageTs = privateMetadata.original_message_ts; // 元のメッセージのタイムスタンプ
    const channelId = privateMetadata.channel_id; // チャンネルID
    const originalText = privateMetadata.original_text; // 元のメッセージのテキスト

    // 元のメッセージを編集してコメントを追加
    try {
        await client.chat.update({
            channel: channelId,
            ts: originalMessageTs,
            text: originalText, // 元のメッセージのテキストを保持
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: originalText // 元のメッセージ内容を保持
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*User Comment:*\n${comment}` // 入力されたコメントを追加
                    }
                }
            ]
        });
    } catch (error) {
        console.error('Error updating the message:', error);
    }
});

// Expressエンドポイントの設定
server.get('/send-tasks', async (req, res) => {
    await sendTasksToSlack();
    res.send('Tasks sent to Slack.');
});

// サーバーの起動
(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('⚡️ Slack app is running!');

    server.listen(port, () => {
        console.log(`🌐 Server is running on http://localhost:${port}`);
    });
})();
