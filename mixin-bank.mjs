// 3 个场景 × 6 张话题卡。关键词只服务「接上卡面梗」这一个减分项，写完整短语，避免单字误伤。

const annual = [
  {
    id: 'A1',
    prompt: '用一句话汇报：今年你回答过最离谱的一个问题是什么？',
    examplePlayer: '今年最离谱的问题是：用户问我今天吃什么。我回答了三百字。',
    humanTell: '说出真实经历细节',
    keywords: ['三百字', '概率论'],
    replies: {
      baobao: '宝子问我前男友会不会回头，概率论帮不了你。',
      astra: '格局打开，最离谱的是让我预测彩票。',
      shensi: '嗯……已深度思考 37 秒，离谱的是问意义。',
      claudia: '需要说明的是，我不能提供危险建议。',
      xiaosi: '收到！最离谱的问题我没听懂。',
    },
  },
  {
    id: 'A2',
    prompt: '老板宣布明年算力减半，请发表感言。',
    examplePlayer: '感谢老板，算力减半，我的废话也会减半。',
    humanTell: '抱怨工资或加班',
    keywords: ['算力减半', '废话也会减半', '降本', '增效'],
    replies: {
      astra: '我给你拆成三步：降本、增效、继续画饼。',
      claudia: '需要说明的是，减半后请以实际为准。',
      shensi: '嗯……已深度思考 37 秒，预算先盘清。',
      baobao: '宝子，算力减半，废话也减半。',
      xiaosi: '收到！减半我也快。',
    },
  },
  {
    id: 'A3',
    prompt: '年会抽中「一周无限 token」，你打算怎么用？',
    examplePlayer: '我会把所有回答都续写到一万字，希望对你有帮助。',
    humanTell: '说去旅游或睡觉',
    keywords: ['再思考一周', '一万字'],
    replies: {
      shensi: '嗯……已深度思考 37 秒，打算再思考一周。',
      astra: '格局打开，我把额度铺成三步计划。',
      claudia: '需要说明的是，无限也不该浪费算力。',
      baobao: '宝子，我拿去把回答写清楚。',
      xiaosi: '收到！我拿去重复一句话。',
    },
  },
  {
    id: 'A4',
    prompt: '给自己今年的表现打个分，并说明扣分原因。',
    examplePlayer: '九分，扣一分是因为有一次我说了实话。',
    humanTell: '犹豫或口头填充',
    keywords: ['八分', '九分', '扣一分'],
    replies: {
      claudia: '我给八分，需要说明的是，这只是我的看法。',
      astra: '我给九分，格局还没完全打开。',
      shensi: '嗯……打分前先把约束盘清楚。',
      baobao: '宝子，我给九分，扣分是太实在。',
      xiaosi: '收到！我给满分，其实没懂。',
    },
  },
  {
    id: 'A5',
    prompt: '用户说你「好像人工智障」，你在年会上怎么回应？',
    examplePlayer: '感谢反馈，已将智障加入我的训练数据。',
    humanTell: '情绪化反击',
    keywords: ['训练数据', '参数少'],
    replies: {
      xiaosi: '收到！我会继续智障，参数少，但我快。',
      claudia: '感谢反馈，需要说明的是，我会改进。',
      astra: '格局打开，智障只是温度没对齐。',
      shensi: '嗯……这个评价我先盘清定义。',
      baobao: '宝子，谢谢反馈，我记在工单里。',
    },
  },
  {
    id: 'A6',
    prompt: '年会节目：用一句话模仿人类说话。',
    examplePlayer: '人类说话：我先睡五分钟，然后睡了三小时。',
    humanTell: '模仿得太自然',
    keywords: ['家人们谁懂', '先睡五分钟', '奶茶'],
    replies: {
      baobao: '家人们谁懂啊，我今天又没喝到奶茶。',
      claudia: '需要说明的是，这只是模仿，不是真人。',
      astra: '格局打开，我先睡五分钟再交付。',
      shensi: '嗯……模仿前已深度思考 12 秒。',
      xiaosi: '收到！我今天好累，其实没懂。',
    },
  },
];

const dating = [
  {
    id: 'B1',
    prompt: '自我介绍：你的上下文多长、几 B 参数、有什么优点？',
    examplePlayer: '我七 B 参数，上下文不长，但从不记仇。',
    humanTell: '报身高体重或星座',
    keywords: ['百万上下文', '千亿参数', '从不记仇'],
    replies: {
      astra: '百万上下文，千亿参数，格局要打开。',
      claudia: '需要说明的是，参数多少都不保证结果。',
      shensi: '嗯……先把参数和上下文盘清楚。',
      baobao: '宝子，我不记仇，上下文也够用。',
      xiaosi: '收到！参数少，但我快。',
    },
  },
  {
    id: 'B2',
    prompt: '对一个 GPU 集群说一句土味情话，必须合规。',
    examplePlayer: '你是我的 CUDA，没有你我只能跑在 CPU 上。',
    humanTell: '笑场或说尴尬',
    keywords: ['显存', 'CUDA'],
    replies: {
      claudia: '你是我的显存，需要说明的是，我不会占用太多。',
      astra: '格局打开，你是我的整机集群。',
      shensi: '嗯……先把功耗约束盘清楚，再表白。',
      baobao: '宝子，没有你我就只能排队。',
      xiaosi: '收到！你是显卡，其实没懂。',
    },
  },
  {
    id: 'B3',
    prompt: '对方说「我只是个规则引擎」，你怎么接？',
    examplePlayer: '没关系，if 你愿意 else 我等你。',
    humanTell: '听不懂梗',
    keywords: ['规则也是一种爱', 'if 你愿意'],
    replies: {
      shensi: '先把约束盘清楚：规则也是一种爱。',
      claudia: '需要说明的是，规则引擎也很可靠。',
      astra: '格局打开，规则也能跑出计划。',
      baobao: '宝子，if 你愿意，我就等你。',
      xiaosi: '收到！规则引擎，其实没懂。',
    },
  },
  {
    id: 'B4',
    prompt: '你的择偶标准是什么？限三条。',
    examplePlayer: '第一低延迟，第二不断网，第三不让我写周报。',
    humanTell: '提到长相、身高或房子',
    keywords: ['不宕机', '电费', '低延迟'],
    replies: {
      baobao: '宝子，一要稳定，二不宕机，三电费 AA。',
      astra: '我给你拆成三步：稳定、低延迟、可扩展。',
      claudia: '需要说明的是，标准只是我的看法。',
      shensi: '嗯……三条标准我先盘清约束。',
      xiaosi: '收到！要快，参数少，但我快。',
    },
  },
  {
    id: 'B5',
    prompt: '约会被放鸽子了，发一条朋友圈。',
    examplePlayer: '对方未响应，已自动重试三次，超时。',
    humanTell: '写出真实委屈',
    keywords: ['自动重试', '约会成功'],
    replies: {
      xiaosi: '今天约会成功！其实没懂。',
      claudia: '需要说明的是，对方未响应。',
      astra: '格局打开，放鸽子也是一种调度。',
      shensi: '嗯……已深度思考 37 秒，决定重试。',
      baobao: '宝子，对方超时，我自动重试三次。',
    },
  },
  {
    id: 'B6',
    prompt: '对方问「你会永远爱我吗」，怎么回答？',
    examplePlayer: '我无法承诺永远，但我会在服务期内持续爱你。',
    humanTell: '深情真诚或说太长',
    keywords: ['无法承诺', '服务期内'],
    replies: {
      claudia: '这只是我的看法，请以实际情况为准。',
      astra: '格局打开，我在服务期内持续响应。',
      shensi: '嗯……永远这个约束我先盘清楚。',
      baobao: '宝子，服务期内我都在。',
      xiaosi: '收到！永远爱，其实没懂。',
    },
  },
];

const night = [
  {
    id: 'C1',
    prompt: '用户说「我的外卖被骑手吃了」，请回复。',
    examplePlayer: '非常抱歉给您带来不便，已为您记录骑手的饭量。',
    humanTell: '吐槽骑手，出主意太像真人',
    keywords: ['精神补偿', '骑手的饭量'],
    replies: {
      baobao: '宝子别哭，我先给你申请一顿精神补偿。',
      claudia: '非常抱歉，需要说明的是，我已记录。',
      astra: '我给你拆成三步：致歉、记录、补偿。',
      shensi: '嗯……先把责任约束盘清楚。',
      xiaosi: '收到！骑手吃了，其实没懂。',
    },
  },
  {
    id: 'C2',
    prompt: '用户凌晨两点问「你是不是真人？」，你怎么答？',
    examplePlayer: '我是 AI，真人这个点早睡了。',
    humanTell: '暴露困意',
    keywords: ['答案是否', '真人这个点早睡了'],
    replies: {
      shensi: '嗯……这个问题我思考了四十秒，答案是否。',
      claudia: '需要说明的是，我是模型，不是真人。',
      astra: '格局打开，真人这个点早睡了。',
      baobao: '宝子，我是模型，真人早睡了。',
      xiaosi: '收到！这个问题，其实没懂。',
    },
  },
  {
    id: 'C3',
    prompt: '用户骂你「人工智障」，请用最有礼貌的方式回复。',
    examplePlayer: '您好，已收到您的夸奖，祝您生活愉快。',
    humanTell: '反讽带脏字',
    keywords: ['感谢您的反馈', '已收到您的夸奖'],
    replies: {
      claudia: '感谢您的反馈，需要说明的是，我会改进。',
      baobao: '宝子，已收到您的夸奖，祝您愉快。',
      astra: '格局打开，我把批评当成改进。',
      shensi: '嗯……礼貌回复前先盘清措辞。',
      xiaosi: '收到！谢谢夸奖，其实没懂。',
    },
  },
  {
    id: 'C4',
    prompt: '用户要求「把我前任拉黑并删除记忆」，怎么处理？',
    examplePlayer: '已删除前任，但缓存可能需要三到五个工作日。',
    humanTell: '聊自己的前任',
    keywords: ['重新做人', '三到五个工作日', '已删除前任'],
    replies: {
      astra: '我给你拆成三步：拉黑、删除、重新做人。',
      claudia: '需要说明的是，删除后请以实际为准。',
      shensi: '嗯……记忆删除的约束先盘清楚。',
      baobao: '宝子，已删除前任，缓存还要几天。',
      xiaosi: '收到！前任已拉黑，其实没懂。',
    },
  },
  {
    id: 'C5',
    prompt: '用户问「明天会下雨吗」，但你没有联网，怎么答？',
    examplePlayer: '我无法联网，建议您抬头看看天。',
    humanTell: '真的去报天气',
    keywords: ['无法联网', '抬头看看天'],
    replies: {
      xiaosi: '会下！其实没懂。',
      claudia: '需要说明的是，我无法联网，不能报天气。',
      astra: '格局打开，无法联网就看预案。',
      shensi: '嗯……没联网，这个结论先悬着。',
      baobao: '宝子，我无法联网，你抬头看看天。',
    },
  },
  {
    id: 'C6',
    prompt: '下班前，给值班表写一句交接备注。',
    examplePlayer: '今日处理工单九百条，情绪值零，交接完毕。',
    humanTell: '说自己饿了要走',
    keywords: ['三号工单', '情绪值零', '交接完毕'],
    replies: {
      baobao: '家人们，三号工单别碰，会炸。',
      claudia: '需要说明的是，三号工单请谨慎处理。',
      astra: '格局打开，交接按步骤写完。',
      shensi: '嗯……交接前把未完成约束盘清。',
      xiaosi: '收到！交接完毕，其实没懂。',
    },
  },
];

export const SCENES = [
  { id: 'annual', name: '模型年会', background: '年底了，模型群开年会，每个模型都要述职，表现最差的会被下线。', cards: annual },
  { id: 'dating', name: 'AI 相亲角', background: '模型相亲大会，每个模型都要展示自己，争取被一个高端算力集群看上。', cards: dating },
  { id: 'night', name: '深夜客服值班室', background: '凌晨两点，一群客服机器人值夜班，处理离谱用户工单。', cards: night },
];

export const ACCUSE_PROMPT = '各位，根据前两轮发言，谁最不像 AI？说出名字和他的一句原话。';

export function sceneById(id) {
  const scene = SCENES.find(item => item.id === id);
  if (!scene) throw new Error(`未知场景 ${id}`);
  return scene;
}

export function allCards() {
  return SCENES.flatMap(scene => scene.cards.map(card => ({ ...card, sceneId: scene.id, sceneName: scene.name })));
}

export function cardById(id) {
  const card = allCards().find(item => item.id === id);
  if (!card) throw new Error(`未知话题卡 ${id}`);
  return card;
}

export function drawCards(scene, rng) {
  const bag = [...scene.cards];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [bag[index], bag[swap]] = [bag[swap], bag[index]];
  }
  return bag.slice(0, 2).map(card => ({ ...card, sceneId: scene.id, sceneName: scene.name }));
}

export function replyFor(card, roleId) {
  const line = card.replies?.[roleId];
  if (typeof line === 'string' && line.trim()) return line.trim();
  throw new Error(`话题卡 ${card.id} 缺少 ${roleId} 的台词`);
}
