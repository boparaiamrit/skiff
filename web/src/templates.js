// The template library: ready-made requests the user can tap to start a
// conversation. {placeholders} become small form fields before sending.
// needs: 'p' = uses phone control, 'c' = works on the open
// project, '' = plain conversation or Linux.

export const CATS = [
  ['whatsapp', 'MessageCircle', 'WhatsApp & messages'],
  ['music', 'Music', 'Music & media'],
  ['catchup', 'Bell', 'Catch up'],
  ['time', 'AlarmClock', 'Time & calendar'],
  ['screen', 'ScanEye', 'On my screen'],
  ['device', 'Settings2', 'Phone settings'],
  ['routines', 'Sunrise', 'Routines'],
  ['travel', 'Compass', 'Travel & places'],
  ['shopping', 'ShoppingBag', 'Shopping & bills'],
  ['social', 'Megaphone', 'Social & news'],
  ['files', 'FolderOpen', 'Photos & files'],
  ['code', 'Code', 'Code'],
  ['writing', 'PenLine', 'Writing & thinking'],
  ['health', 'HeartPulse', 'Health'],
];

// field name → [label, placeholder]
export const FIELDS = {
  contact: ['Who', 'Name as saved on your phone'],
  group: ['Group', 'Group name'],
  intent: ['The reply should', 'say I\'ll be there by 7'],
  message: ['Message', 'What to say'],
  topic: ['About', 'Topic'],
  music: ['What to play', 'Artist, song, album or mood'],
  percent: ['Percent', '40'],
  minutes: ['Minutes', '30'],
  podcast: ['Podcast', 'Podcast name'],
  playlist: ['Playlist', 'Playlist name'],
  time: ['Time', '6:30 am'],
  event: ['What', 'Dentist appointment'],
  when: ['When', 'Friday 4 pm'],
  language: ['Language', 'Punjabi'],
  details: ['Details', 'Name, email, address…'],
  device: ['Device', 'Galaxy Buds'],
  place: ['Place', 'Where to'],
  thing: ['What', 'Coffee, petrol pump, pharmacy…'],
  flight: ['Flight', 'AI 101'],
  train: ['Train', 'Train number or name'],
  item: ['Product', 'What to look for'],
  amount: ['Amount', '₹2,400'],
  count: ['People', '4'],
  app: ['App', 'Instagram'],
  what: ['What', 'What to look for'],
  folder: ['Folder', 'DCIM/Camera'],
  file: ['File', '/sdcard/Download/report.pdf'],
  idea: ['Idea', 'A habit tracker'],
  task: ['Task', 'renames my photos by date'],
  notes: ['Notes', 'Paste your notes'],
  request: ['Request', 'What you were asked'],
  dish: ['Dish', 'Rajma chawal'],
};

const T = [
  // ---- WhatsApp & messages
  ['wa-waiting', 'whatsapp', 'Hourglass', 'Who\'s waiting on me?', 'p', 'Open WhatsApp and check my chats that have unread messages or where the other person spoke last. List each person or group, what they said, and how long they have been waiting, most urgent first. Don\'t reply to anyone.'],
  ['wa-questions', 'whatsapp', 'CircleHelp', 'Who asked me what', 'p', 'Go through my unread and recent WhatsApp chats and list every question someone asked me, grouped by person, with a one-line suggested reply for each. Don\'t send anything.'],
  ['wa-sum-chat', 'whatsapp', 'NotebookPen', 'Summarize a chat', 'p', 'Open my WhatsApp chat with {contact}. Read the recent messages, scrolling up far enough to cover the last few days, and summarize what we talked about, any decisions, and anything I promised or still owe them.'],
  ['wa-sum-group', 'whatsapp', 'Users', 'Summarize a group', 'p', 'Open the WhatsApp group {group}. Read the messages since I last wrote there (scroll up as needed) and give me the key points, decisions, anything that mentions me, and links or files shared.'],
  ['wa-groups', 'whatsapp', 'Newspaper', 'Catch me up on my groups', 'p', 'Check my WhatsApp groups that have unread messages and give me one short paragraph per group on what happened. Flag anything that needs my action.'],
  ['wa-pickup', 'whatsapp', 'Undo2', 'Pick up where we left off', 'p', 'Open my WhatsApp chat with {contact}, find where our conversation stopped, and tell me what the open thread was. Then suggest two natural ways I could continue it.'],
  ['wa-draft', 'whatsapp', 'PenLine', 'Draft a reply', 'p', 'Open my WhatsApp chat with {contact}, read the last few messages, and type a reply that {intent}. Match the tone and language of our chat. Leave it in the message box without sending so I can check it.'],
  ['wa-send', 'whatsapp', 'Send', 'Send a WhatsApp message', 'p', 'Send {contact} this on WhatsApp: {message}'],
  ['wa-find', 'whatsapp', 'Search', 'Find something in my chats', 'p', 'Search WhatsApp for {topic} and tell me which chats and messages mention it, with dates.'],
  ['wa-bday', 'whatsapp', 'Cake', 'Birthday wish', 'p', 'Write a warm birthday message for {contact} in the tone of our WhatsApp chat (read a few recent messages first), type it in our chat, and leave it unsent for me to check.'],
  ['wa-translate', 'whatsapp', 'Languages', 'Translate and reply', 'p', 'Open my WhatsApp chat with {contact}, translate their last messages into English for me, then draft a reply in their language that says: {message}. Don\'t send it.'],
  ['wa-missed', 'whatsapp', 'PhoneMissed', 'Missed calls', 'p', 'Check the Phone app and WhatsApp Calls for missed calls today. List who called, when, and whether they also messaged me.'],
  ['sms-unread', 'whatsapp', 'Mail', 'SMS that matter', 'p', 'Open Messages and summarize unread SMS from people or important services. Skip promotions and one-time codes.'],
  ['wa-todos', 'whatsapp', 'ListTodo', 'To-dos from my chats', 'p', 'Read my recent WhatsApp chats and make a to-do list of things I said I would do or was asked to do, with who asked and by when.'],
  ['wa-status', 'whatsapp', 'CircleDot', 'Status round-up', 'p', 'Open WhatsApp Updates and tell me briefly who posted a status today and what it was about.'],

  // ---- Music & media
  ['mu-play', 'music', 'Music', 'Play on YouTube Music', 'p', 'Play {music} on YouTube Music.'],
  ['mu-liked', 'music', 'Heart', 'Play my liked songs', 'p', 'Open YouTube Music, go to Library → Liked music, and play it on shuffle.'],
  ['mu-history', 'music', 'History', 'What do I usually play?', 'p', 'Open YouTube Music → Library → History. Read what I have played recently (scroll a few screens) and tell me my top artists, songs and moods.'],
  ['mu-similar', 'music', 'Sparkles', 'Something like my usual', 'p', 'Check my YouTube Music history, then play something similar to what I usually listen to that I haven\'t played recently. Tell me what you picked and why.'],
  ['mu-last', 'music', 'Repeat', 'Play my last song again', 'p', 'Open YouTube Music → Library → History and play the most recent song again.'],
  ['mu-pause', 'music', 'Pause', 'Pause the music', 'p', 'Pause the music.'],
  ['mu-next', 'music', 'SkipForward', 'Next song', 'p', 'Skip to the next song.'],
  ['mu-volume', 'music', 'Volume2', 'Set the volume', 'p', 'Set the media volume to {percent}%.'],
  ['mu-now', 'music', 'Headphones', 'What\'s playing?', 'p', 'What song is playing right now? Check the notification shade and tell me the title and artist.'],
  ['mu-like', 'music', 'ThumbsUp', 'Like this song', 'p', 'Like the song that is playing in YouTube Music.'],
  ['mu-sleep', 'music', 'Moon', 'Sleep music', 'p', 'Play calm sleep music on YouTube Music, set the media volume to 25%, and start a {minutes} minute timer.'],
  ['mu-workout', 'music', 'Dumbbell', 'Workout mix', 'p', 'Play an energetic workout playlist on YouTube Music and start a {minutes} minute timer.'],
  ['mu-youtube', 'music', 'MonitorPlay', 'Find on YouTube', 'p', 'Open YouTube, search for {topic}, and open the best match.'],
  ['mu-podcast', 'music', 'Podcast', 'Play a podcast', 'p', 'Play the latest episode of the podcast {podcast}.'],
  ['mu-addlist', 'music', 'ListPlus', 'Add to a playlist', 'p', 'Add the song that is playing to my YouTube Music playlist {playlist}.'],

  // ---- Catch up
  ['cu-notifs', 'catchup', 'Bell', 'Summarize my notifications', 'p', 'Open the notification shade, read everything there, and tell me what is important, what can wait, and what I can ignore. Then close the shade.'],
  ['cu-urgent', 'catchup', 'Siren', 'Anything urgent?', 'p', 'Check my notifications, WhatsApp and SMS for anything urgent or time-sensitive from the last few hours. Only the urgent items, or tell me there is nothing.'],
  ['cu-gmail', 'catchup', 'Mail', 'Important unread email', 'p', 'Open Gmail and summarize unread emails from real people (skip newsletters and promotions): who, what they want, and whether it needs a reply.'],
  ['cu-mailreply', 'catchup', 'Reply', 'Draft an email reply', 'p', 'Open Gmail, find the latest email from {contact}, and write a reply that {intent}. Leave it as a draft.'],
  ['cu-orders', 'catchup', 'Package', 'Where are my orders?', 'p', 'Check my notifications, SMS and shopping apps (Amazon, Flipkart) for order and delivery updates. List what is arriving and when.'],
  ['cu-spend', 'catchup', 'Wallet', 'Today\'s spending', 'p', 'Read today\'s bank and UPI transaction SMS (don\'t open any banking app) and list what I spent and where, with a total.'],
  ['cu-noisy', 'catchup', 'BellOff', 'Which apps spam me?', 'p', 'Look at my notifications and tell me which apps send the most. Suggest which ones I could mute.'],
  ['cu-bills', 'catchup', 'Receipt', 'Bills due soon', 'p', 'Check my SMS and Gmail for bills or payments due in the next 7 days and list them with amounts and dates. Don\'t pay anything.'],

  // ---- Time & calendar
  ['tm-alarm', 'time', 'AlarmClock', 'Set an alarm', 'p', 'Set an alarm for {time}.'],
  ['tm-timer', 'time', 'Timer', 'Start a timer', 'p', 'Start a {minutes} minute timer.'],
  ['tm-today', 'time', 'CalendarDays', 'What\'s on today?', 'p', 'Open my calendar and tell me what is on today and tomorrow, with times and places.'],
  ['tm-add', 'time', 'CalendarPlus', 'Add to my calendar', 'p', 'Add {event} to my calendar on {when}.'],
  ['tm-wake', 'time', 'Sunrise', 'Wake me up in time', 'p', 'I need to be at {event} by {time}. Work out a sensible wake-up time, allowing for getting ready and travel, and set an alarm.'],
  ['tm-plan', 'time', 'LayoutList', 'Plan my day', 'p', 'Look at today\'s calendar and my unread messages, then suggest a simple plan for the day in time blocks.'],
  ['tm-bed', 'time', 'BedDouble', 'Bedtime', 'p', 'Set an alarm 8 hours from now and turn on Do Not Disturb.'],
  ['tm-focus', 'time', 'Target', 'Focus for 25 minutes', 'p', 'Turn on Do Not Disturb and start a 25 minute timer for a focus session.'],
  ['tm-free', 'time', 'CalendarSearch', 'When am I free?', 'p', 'Check my calendar and tell me when I am free this week for a {minutes} minute meeting.'],

  // ---- On my screen
  ['sc-what', 'screen', 'ScanEye', 'What\'s on my screen?', 'p', 'Look at my screen and tell me what is there.'],
  ['sc-translate', 'screen', 'Languages', 'Translate my screen', 'p', 'Translate everything on my screen into {language}.'],
  ['sc-summary', 'screen', 'FileText', 'Summarize this page', 'p', 'Summarize the article or page I am reading. Scroll down to read all of it first, then scroll back up.'],
  ['sc-explain', 'screen', 'Lightbulb', 'Explain this', 'p', 'Explain what is on my screen in simple words. If it is an error or a warning, tell me what to do about it.'],
  ['sc-copy', 'screen', 'ClipboardCopy', 'Copy the text', 'p', 'Copy all the text on my screen to the clipboard, cleaned up.'],
  ['sc-form', 'screen', 'FormInput', 'Fill this form', 'p', 'Fill the form on my screen with: {details}. Don\'t submit it.'],
  ['sc-compare', 'screen', 'Scale', 'Compare these options', 'p', 'Compare the options on my screen (prices, features, ratings) and tell me which is the best value.'],
  ['sc-shot', 'screen', 'Camera', 'Screenshot and describe', 'p', 'Take a screenshot and describe it in detail.'],

  // ---- Phone settings
  ['dv-dnd', 'device', 'MoonStar', 'Do Not Disturb on', 'p', 'Turn on Do Not Disturb.'],
  ['dv-wifi', 'device', 'Wifi', 'Check my Wi-Fi', 'p', 'Open Wi-Fi settings and tell me which network I am on and whether it is working.'],
  ['dv-bt', 'device', 'Bluetooth', 'Connect Bluetooth', 'p', 'Turn on Bluetooth and connect to {device}.'],
  ['dv-battery', 'device', 'BatteryMedium', 'Battery report', 'p', 'Check the battery level and which apps used the most battery today.'],
  ['dv-saver', 'device', 'BatteryLow', 'Power saving on', 'p', 'Turn on power saving mode.'],
  ['dv-storage', 'device', 'HardDrive', 'What\'s using storage?', 'p', 'Open storage settings and tell me what is using the most space.'],
  ['dv-updates', 'device', 'Download', 'App updates', 'p', 'Open the Play Store, check for app updates, and tell me which apps have one. Don\'t update anything without asking.'],
  ['dv-screentime', 'device', 'Smartphone', 'Screen time today', 'p', 'Open Digital Wellbeing and tell me my screen time today and which apps I used most.'],
  ['dv-bright', 'device', 'Sun', 'Brightness', 'p', 'Set the screen brightness to about {percent}%.'],
  ['dv-hotspot', 'device', 'RadioTower', 'Hotspot on', 'p', 'Turn on the mobile hotspot and tell me its network name.'],
  ['dv-dark', 'device', 'SunMoon', 'Toggle dark mode', 'p', 'Switch dark mode on if it is off, or off if it is on.'],

  // ---- Routines
  ['rt-morning', 'routines', 'Coffee', 'Morning briefing', 'p', 'Give me a morning briefing: today\'s calendar, unread WhatsApp messages that matter, important notifications, and the weather here. Keep it short. Then play something upbeat on YouTube Music.'],
  ['rt-night', 'routines', 'Sunset', 'Wind down', 'p', 'Evening wind-down: tell me what is on my calendar tomorrow, set an alarm for {time}, turn on Do Not Disturb, and play calm music at low volume.'],
  ['rt-leaving', 'routines', 'Car', 'Leaving now', 'p', 'Get directions to {place} in Google Maps and tell me the ETA. Then draft a WhatsApp message to {contact} saying I am on my way with that ETA. Don\'t send it until I confirm.'],
  ['rt-inbox', 'routines', 'Inbox', 'Clear my chats with me', 'p', 'Help me clear my unread WhatsApp chats one by one: show me the last message and a suggested reply, and wait for my OK before typing each one.'],
  ['rt-eod', 'routines', 'ClipboardCheck', 'End-of-day review', 'p', 'Review my day: what happened according to my calendar and chats, what is still open, and what I should do first tomorrow.'],
  ['rt-gym', 'routines', 'Activity', 'Gym mode', 'p', 'Turn on Do Not Disturb, play a workout playlist on YouTube Music, and start a {minutes} minute timer.'],
  ['rt-week', 'routines', 'CalendarRange', 'Weekly review', 'p', 'Look at my calendar for this week and next, plus my pending WhatsApp conversations, and give me a weekly review with my top priorities.'],
  ['rt-cook', 'routines', 'CookingPot', 'Cook with me', 'p', 'I am cooking {dish}. Give me the steps briefly and start a timer for each step that needs one, beginning with the first.'],

  // ---- Travel & places
  ['tr-nav', 'travel', 'Navigation', 'Directions', 'p', 'Start Google Maps navigation to {place}.'],
  ['tr-near', 'travel', 'MapPin', 'Find nearby', 'p', 'Find {thing} near me in Google Maps and tell me the three best options with rating and distance.'],
  ['tr-cab', 'travel', 'CarTaxiFront', 'Price a cab', 'p', 'Open Uber or Ola with the destination {place} and tell me the price options. Don\'t book until I confirm.'],
  ['tr-flight', 'travel', 'Plane', 'Flight status', '', 'Check the status of flight {flight} today.'],
  ['tr-train', 'travel', 'TrainFront', 'Train status', '', 'Check the running status of train {train} today.'],
  ['tr-trip', 'travel', 'Luggage', 'Trip checklist', 'p', 'I am travelling to {place} on {when}. Make a packing and to-do checklist, and add the trip to my calendar.'],
  ['tr-weather', 'travel', 'CloudSun', 'Weather', '', 'What is the weather in {place} today and tomorrow?'],

  // ---- Shopping & bills
  ['sh-compare', 'shopping', 'ShoppingCart', 'Compare prices', 'p', 'Compare the price of {item} on Amazon and Flipkart (open the apps and search). Tell me the best deal with delivery dates. Don\'t buy anything.'],
  ['sh-track', 'shopping', 'Truck', 'Track my orders', 'p', 'Open Amazon and tell me the status of my latest orders.'],
  ['sh-reorder', 'shopping', 'RotateCcw', 'Reorder something', 'p', 'Find my last order of {item} on Amazon and add it to the cart. Stop before checkout.'],
  ['sh-data', 'shopping', 'Signal', 'Data balance', 'p', 'Check my mobile data balance and plan validity in my carrier\'s app (MyJio, Airtel Thanks or Vi).'],
  ['sh-split', 'shopping', 'Calculator', 'Split a bill', 'p', 'Split {amount} equally among {count} people and draft a WhatsApp message to {group} with each person\'s share. Don\'t send it.'],
  ['sh-deal', 'shopping', 'Tag', 'Is this a good deal?', 'p', 'Look at the product on my screen and check whether it is a good price by comparing it in another app or on the web.'],

  // ---- Social & news
  ['so-linkedin', 'social', 'Briefcase', 'LinkedIn post', '', 'Write a LinkedIn post about {topic} in my voice: clear, specific, no hashtag spam. Show it to me first.'],
  ['so-caption', 'social', 'ImagePlus', 'Instagram captions', '', 'Suggest five captions for a photo about {topic}: two short, two playful, one thoughtful.'],
  ['so-dms', 'social', 'MessagesSquare', 'Check Instagram DMs', 'p', 'Open Instagram and summarize my unread DMs. Don\'t reply.'],
  ['so-comments', 'social', 'MessageSquareText', 'Reply to comments', 'p', 'Open {app}, read the recent comments on my latest post, and draft friendly replies for me to review.'],
  ['so-news', 'social', 'Newspaper', 'News briefing', '', 'Give me today\'s top news about {topic}: five bullet points with sources.'],
  ['so-trend', 'social', 'TrendingUp', 'What\'s trending', '', 'Search the web for what is trending today in {topic} and give me five headlines with one line each.'],

  // ---- Photos & files
  ['fl-photos', 'files', 'Images', 'Find photos', 'p', 'Open Google Photos, search for {what}, and tell me what you find.'],
  ['fl-sendphoto', 'files', 'Share2', 'Send my last photo', 'p', 'Share my most recent photo with {contact} on WhatsApp. Ask me before sending.'],
  ['fl-pdf', 'files', 'FileStack', 'Photos to PDF', '', 'Combine the images in /sdcard/{folder} into one PDF, in order of date, using Python here in Linux. Save it to /sdcard/Download and tell me its name.'],
  ['fl-shots', 'files', 'FolderTree', 'Tidy my screenshots', '', 'Look at /sdcard/Pictures/Screenshots (and /sdcard/DCIM/Screenshots): tell me how many there are and how much space they take, then propose grouping them into monthly folders. Ask before moving anything.'],
  ['fl-downloads', 'files', 'FolderDown', 'Today\'s downloads', '', 'List the files I downloaded today in /sdcard/Download, with sizes.'],
  ['fl-read', 'files', 'BookOpen', 'Read a document', '', 'Read {file} from my phone storage and summarize it.'],

  // ---- Code
  ['cd-explain', 'code', 'BookOpenText', 'Explain this project', 'c', 'Explain this project: what it does, how it is organised, and how to run it.'],
  ['cd-bug', 'code', 'Bug', 'Find and fix a bug', 'c', 'Find and fix a bug in this project. Explain what was wrong and how you fixed it.'],
  ['cd-tests', 'code', 'FlaskConical', 'Write tests', 'c', 'Write tests for the most important untested code in this project and run them.'],
  ['cd-new', 'code', 'Rocket', 'Start a new web app', '', 'Create a new web app: {idea}. Set it up in ~/projects, run the dev server, and tell me the address to open in the Preview tab.'],
  ['cd-review', 'code', 'GitCompare', 'Review my changes', 'c', 'Review my uncommitted changes (git diff) for bugs, security issues and missing tests.'],
  ['cd-readme', 'code', 'BookMarked', 'Write a README', 'c', 'Write a clear README for this project: what it is, setup, usage and examples.'],
  ['cd-repo', 'code', 'GitFork', 'Put this on GitHub', 'c', 'Create a private GitHub repository for this project with gh, commit everything that should be committed, and push it. Show me what will be committed first.'],
  ['cd-gh', 'code', 'GitPullRequest', 'My GitHub today', '', 'Use gh to show my open pull requests, issues assigned to me, and any failing CI runs on my repositories.'],
  ['cd-dev', 'code', 'Server', 'Run the dev server', 'c', 'Start this project\'s dev server and tell me the address to open in the Preview tab.'],
  ['cd-refactor', 'code', 'WandSparkles', 'Refactor a file', 'c', 'Refactor {file} to be simpler and easier to read without changing what it does. Run the tests afterwards.'],
  ['cd-script', 'code', 'FileCode', 'Write a script', '', 'Write a Python script here in Linux that {task}. Run it once to check it works.'],
  ['cd-deps', 'code', 'PackageCheck', 'Update dependencies', 'c', 'Check this project for outdated dependencies, update the safe ones, and run the tests.'],

  // ---- Writing & thinking
  ['wr-improve', 'writing', 'PenTool', 'Improve my text', 'p', 'Improve the text in my clipboard: clearer and shorter, same meaning. Copy the result back to the clipboard and show it to me.'],
  ['wr-translate', 'writing', 'Languages', 'Translate my clipboard', 'p', 'Translate the text in my clipboard into {language} and copy the translation back to the clipboard.'],
  ['wr-email', 'writing', 'AtSign', 'Write an email', '', 'Write a short, polite email to {contact} about {topic}. Show me the draft.'],
  ['wr-brainstorm', 'writing', 'Brain', 'Brainstorm', '', 'Brainstorm 10 ideas for {topic}, then pick the best three and say why.'],
  ['wr-explain', 'writing', 'GraduationCap', 'Explain simply', '', 'Explain {topic} to me as a beginner, in five short paragraphs with one example.'],
  ['wr-notes', 'writing', 'NotebookText', 'Clean up notes', '', 'Turn these notes into a clean summary with decisions and action items:\n{notes}'],
  ['wr-no', 'writing', 'CircleSlash', 'Say no politely', '', 'Help me say no politely to {request}. Give me two versions: one short and one warmer.'],

  // ---- Health
  ['he-steps', 'health', 'Footprints', 'Today\'s activity', 'p', 'Open Samsung Health and tell me my steps, activity and sleep for today.'],
  ['he-water', 'health', 'Droplet', 'Water reminders', 'p', 'Set alarms every 2 hours from now until 9 pm, labelled "Drink water".'],
  ['he-breathe', 'health', 'Wind', 'Breathing break', 'p', 'Guide me through a 2 minute breathing exercise and start a 2 minute timer.'],
  ['he-sleep', 'health', 'BedSingle', 'Sleep report', 'p', 'Open Samsung Health and summarize my sleep for the last week.'],
];

export const TEMPLATES = T.map(([id, cat, icon, title, needs, prompt]) => ({ id, cat, icon, title, needs, prompt, fields: fieldsOf(prompt) }));

export function fieldsOf(prompt) {
  const out = [];
  for (const m of prompt.matchAll(/\{(\w+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function fill(prompt, values) {
  return prompt.replace(/\{(\w+)\}/g, (_, k) => (values[k] || '').trim() || k);
}

export const byId = (id) => TEMPLATES.find((t) => t.id === id);
