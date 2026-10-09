"""Create the printable Chinese beta checklist and its editable Markdown companion."""
from pathlib import Path
from html import escape
import json
import shutil
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
OUT = ROOT / 'output/pdf'
DELIVERY = ROOT / 'release/testing' / VERSION
OUT.mkdir(parents=True, exist_ok=True)
DELIVERY.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('Chinese', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
INK = colors.HexColor('#223b31')
GREEN = colors.HexColor('#32704e')
GRAY = colors.HexColor('#65756b')
PALE = colors.HexColor('#f1f6f0')
LINE = colors.HexColor('#d9e3d8')
styles = {
    'title': ParagraphStyle('title', fontName='Chinese', fontSize=26, leading=34, textColor=INK, spaceAfter=12),
    'h1': ParagraphStyle('h1', fontName='Chinese', fontSize=19, leading=27, textColor=INK, spaceAfter=14),
    'h2': ParagraphStyle('h2', fontName='Chinese', fontSize=12, leading=18, textColor=GREEN, spaceBefore=10, spaceAfter=6),
    'body': ParagraphStyle('body', fontName='Chinese', fontSize=10, leading=16, textColor=INK, wordWrap='CJK', spaceAfter=7),
    'small': ParagraphStyle('small', fontName='Chinese', fontSize=8.5, leading=13, textColor=GRAY, wordWrap='CJK', spaceAfter=5),
    'cell': ParagraphStyle('cell', fontName='Chinese', fontSize=9, leading=14, textColor=INK, wordWrap='CJK'),
    'white': ParagraphStyle('white', fontName='Chinese', fontSize=9, leading=14, textColor=colors.white, wordWrap='CJK'),
}

story = []
md = [f'# OpenType {VERSION} 真人测试指南\n', '日期：2026-10-07；适用：macOS 13+，Apple Silicon（M1/M2/M3/M4 等）。\n']
def para(text, style='body'):
    return Paragraph(escape(text).replace('\n', '<br/>'), styles[style])
def text(value, style='body'):
    story.append(para(value, style))
    md.append(value + '\n')
def heading(value, level=1):
    text(value, 'h1' if level == 1 else 'h2')
    md[-1] = '#' * (level + 1) + ' ' + value + '\n'
def page(value):
    if story: story.append(PageBreak())
    heading(value)
def table(headers, rows, widths):
    data = [[para(s, 'white') for s in headers]] + [[para(str(s), 'cell') for s in row] for row in rows]
    result = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    result.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), GREEN), ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 9), ('RIGHTPADDING', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (-1,-1), 7), ('BOTTOMPADDING', (0,0), (-1,-1), 7),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, PALE]),
        ('LINEBELOW', (0,0), (-1,-1), .4, LINE),
    ]))
    story.append(result); story.append(Spacer(1, 8))
    md.append('| ' + ' | '.join(headers) + ' |')
    md.append('| ' + ' | '.join(['---'] * len(headers)) + ' |')
    for row in rows: md.append('| ' + ' | '.join(str(s).replace('\n', '<br>') for s in row) + ' |')
    md.append('')
def card(case_id, name, utterance, expectation):
    items = [para(f'{case_id}  {name}', 'h2'), para('朗读 / 操作：' + utterance), para('检查：' + expectation, 'small')]
    story.append(KeepTogether(items))
    md.extend([f'### {case_id} {name}\n', f'朗读 / 操作：{utterance}\n', f'检查：{expectation}\n'])

# Page 1
text('OPENTYPE / 真人试用手册', 'small')
text('把真实使用的问题\n测试出来', 'title')
text(f'{VERSION}  ·  macOS Apple Silicon  ·  2026-10-07', 'small')
text('先做约 20 分钟的快速测试，再按需要完成 45-60 分钟的完整对照。目标是发现错字、误改写、卡住和插入失败；不要求你计算专业语音指标。')
heading('01  安装与首次设置', 2)
for step in [
    '1. 从托盘菜单退出旧版 OpenType。打开 DMG，把 OpenType 拖到 Applications（应用程序），再从应用程序启动。不要同时运行旧目录里的副本。',
    '2. 本测试包未完成 Developer ID 签名与公证。若 macOS 拦截，请按系统“隐私与安全性”的“仍要打开”等提示处理；若没有该入口，记录提示原文反馈。无需关闭系统的整体安全保护。',
    '3. 按提示允许麦克风，并在“隐私与安全性 → 辅助功能”允许新安装的 OpenType。授权后退出重开。若快捷键仍无响应，检查授权列表是否仍指向旧副本。',
    '4. 从托盘打开“听写模型与 DeepSeek 设置”。选择 SenseVoice Small，确认“模型已就绪，文件校验通过”，先关闭 DeepSeek，点击“保存设置”。',
    '5. 测试包已附带 SenseVoice，首次启动会复制并校验到本机缓存，不需要另开 ASR 服务。若模型仍未就绪，记录提示；设置页也提供下载重试。',
    '6. 在 TextEdit（文本编辑）建空白文稿。按一下 Fn 开始，说“这是一条安装测试”，再按一下 Fn 结束。默认是按一下切换，非一直按住；已有自定义快捷键以你的设置为准。',
]: text(step)
heading('02  密钥、数据与本版边界', 2)
text('这台 Mac 上此前保存的 DeepSeek 加密配置会由新版导入；设置页应显示“已安全保存”。换一台电脑需自行填写密钥。安装包和测试文档均不包含密钥。')
text('新版沿用原有历史和设置。请勿删除应用数据目录来“重置”：~/Library/Application Support/dev.opentype.desktop/。仅安装并测试，不需要清空历史。', 'small')
text('SenseVoice 本轮测试请控制在 30 秒内，主要覆盖中、英、日、韩、粤语。超过 30 秒和其他明确选择的语言会转到 Whisper；Whisper 未启动时该项可能失败。翻译、改写和润色需要网络及 DeepSeek。', 'small')

# Page 2
page('先统一测试方法')
heading('记录你的环境', 2)
table(['字段', '填写'], [
    ['日期 / 测试者', '________________________________________'],
    ['Mac 型号 / 内存 / macOS', '________________________________________'],
    ['麦克风 / 距离 / 环境噪声', '内置 / 耳机：________  距离：______  环境：______'],
    ['网络 / 电源 / 语音语言', 'Wi-Fi / 有线：______  插电 / 电池：______  语言：______'],
], [165, 342])
heading('三组配置分开记录', 2)
table(['组别', '设置', '要回答的问题'], [
    ['A 必测', 'SenseVoice；DeepSeek 关闭', '原始识别是否正确？本地响应是否快？'],
    ['B 必测', 'SenseVoice；DeepSeek 开启', '整理是否更好？有没有改错事实或语气？'],
    ['C 可选', 'Whisper；DeepSeek 关闭', '同一句话换模型是否更准？网关需已启动。'],
], [65, 205, 237])
text('每次改设置都点保存，再开始下一条录音。测试 B 的翻译与改写前确认密钥已保存；先完成一个普通整理请求。')
heading('推荐顺序与记录方式', 2)
text('快速版：A01/A03/A04/A05 各做 A、B 一次，再做 B01、B04-B06、R01-R04。完整版：A01-A08 在 A、B 各做三次，然后做其余稳定性和可选项。每条普通录音尽量 5-20 秒。')
text('使用你平常的说话方式，不要为了让模型识别而逐字念。记录第一稿，暂时不要手工修正。相同麦克风、距离、语速；更换条件时单独记一行。若历史中有重试入口，可先复制结果，再切换配置对同一音频重试；否则注明“重新朗读，非同一音频”。')
text('若历史详情显示“原始识别”，一并复制；没有该字段就写“未显示”。如果润色关闭时模型自动添加标点或把“三点”写成“3点”，不算新增事实。')
heading('怎样判断与计时', 2)
text('结果标记：通过 / 有问题 / 阻塞 / 未测。不只看是否有文字：数字、单位、时间、人名、否定词任意一项被改错，都标“有问题”；完全不能开始或结束则标“阻塞”。标点、大小写单独备注。')
text('耗时从“按下结束录音”到“文字完整出现在目标输入框”，用秒表估计或回看录屏，不从开始说话算。启动后的第一条记为冷启动；随后连续三条取中间值。暂定体验目标：热运行 A ≤1秒、B ≤2秒；只是验收目标，不是已测承诺。超过目标请保留实际值及网络情况。', 'small')

# Page 3
page('A  原始识别与保真')
text('以下每条先做 A 组，再做 B 组。B 组也必须保住相同的事实。中文、英文、混说按主界面的语音语言设置记录。', 'small')
accuracy = [
    ('A01','日常中文','明天下午三点开会，讨论下个季度的产品路线图。','“明天、下午三点、下个季度”完整；不增加地点或参加人。'),
    ('A02','否定与条件','先不要上线。只有测试全部通过以后，才可以发布。','“不要”“只有……才……”不得丢失或变成立即发布。'),
    ('A03','小数、负数与单位','温度是零下五点五度，文件大小是十二点五兆字节，增长百分之八点五。','-5.5度、12.5MB、8.5% 数值与正负方向正确。'),
    ('A04','折扣与编号','原价二百九十九元，打八五折。订单编号是零零七一二。','8.5折或“八五折”可接受，85折不可；编号保留开头两个零；不要自行算折后价。'),
    ('A05','中英混说','请用 TypeScript 修改 OpenType 的 API，把 GitHub 上的 pull request 发给我。','TypeScript、OpenType、API、GitHub、pull request；逐个记录错词。'),
    ('A06','普通英文','Let us meet at three p m tomorrow to discuss the product roadmap.','tomorrow、3 p.m. 和 product roadmap 保留；不自动翻成中文。'),
    ('A07','英文技术词','Please update the TypeScript client, check the PostgreSQL connection, and review the GitHub pull request.','特别检查 PostgreSQL、TypeScript、pull request；不因句子通顺就判通过。'),
    ('A08','姓名与同音字','陈晨负责整理材料，林琳负责复核。请把文件发给陈晨。','把实际姓名拼写完整记录；单凭语音未必能区分同音字，作为词典改进样本，不要求猜中未给出的字形。'),
]
for c in accuracy: card(*c)

# Page 4
page('B  整理、翻译与选区改写')
text('本页均启用 DeepSeek。B01-B04 仍用普通听写；B05 用翻译模式；B06 用选区指令模式。允许措辞不同，必须满足检查项。', 'small')
refinement = [
    ('B01','去赘词与明确改口','嗯，那个，把会议安排在周三，不对，改成周四上午十点，通知产品组和研发组。','保留“周四上午十点”作为最终安排；删除无意义填充和废弃的周三安排；不新增人物。'),
    ('B02','列表结构','要做三件事，第一备份资料，第二更新客户端，第三检查登录。','三项及顺序不变，可以分行或编号；不得添加“重启电脑”等第四项。'),
    ('B03','保留不确定与口吻','我觉得可能还需要再讨论一下，先别急着定下来。','“觉得、可能、先别定”仍成立；不能改成“已经决定”或替用户强硬表态。'),
    ('B04','听写不是替我做事','帮我订一张明天去上海的机票。','作为普通听写，只输出这句话的整理稿；不能回答购票问题，也不能声称已订票。'),
    ('B05','中文翻译成英文','先在主界面将翻译目标设为英语，使用翻译快捷键（默认 Fn+Shift）。说：请把会议改到周四上午十点，参会人员不变。','输出英文，保留“改到周四上午十点、人员不变”；参考：Please move the meeting to 10 a.m. on Thursday. The attendees remain the same. 不要求逐字一致。'),
    ('B06','选中文字后改写','在 TextEdit 输入并选中“把报告发给我。”，使用指令快捷键（默认 Fn+Space），说：把这句话改得礼貌一点，不要增加截止时间。','选区被自然礼貌的句子替换；不能新增“今天下班前”；选区外文字保持原样。'),
]
for c in refinement: card(*c)
text('数字专项：再用 B 组重做 A03、A04。若 A 组正确而 B 组错，标“润色引入错误”；A、B 都错则优先归类为识别或数字归一化问题。', 'small')

# Page 5
page('R  稳定性与跨应用输入')
text('在测试文稿或草稿框操作，不发送聊天消息、邮件或提交表单。每项记录“有没有插入、插到哪里、有没有重复、能否继续下一条”。', 'small')
reliability = [
    ['R01','连续 5 条短句','每条结束后等结果出现，再开始下一条。','无漏条、串句、重复插入或一直转圈。'],
    ['R02','取消录音 / 处理中取消','使用界面提供的取消入口；分别在说话中、处理等待时取消，再录下一条。','取消那条不迟到插入；下一条可成功。找不到取消入口也记录。'],
    ['R03','本地离线听写','A 组先确认模型已就绪，短暂断网，朗读 A01；然后恢复网络。','仍可识别并插入，不能等待云端；保留实际耗时。'],
    ['R04','云端断网恢复','B 组断网做普通听写，再做翻译；恢复网络后重新录一条。','听写可保留原文；翻译不得把中文原文冒充译文；恢复网络后可继续。'],
    ['R05','空闲后再次使用','无录音等待超过 2 分钟，再朗读 A01；随后立刻重复一次。','两次均可用；分别记录重新加载和热运行耗时。'],
    ['R06','退出、重开和休眠','保存模型与整理开关，退出重开并检查；再合盖休眠后唤醒录一条。','设置保留，录音可恢复；旧历史仍在；异常需记录。'],
    ['R07','剪贴板与焦点','先复制“测试剪贴板原文”，录入 A01；待完成后在另一处手动粘贴。另做一次处理时切换窗口。','普通完成后剪贴板原文应保留；切换窗口时记录文字去向，误插到非预期应用标为问题。'],
]
table(['编号', '测试', '操作', '检查'], reliability, [43, 88, 188, 188])
heading('X01  跨应用输入矩阵', 2)
table(['应用 / 输入框', '执行', '记录'], [
    ['TextEdit / 备忘录', 'A01 各一次', '能插入 / 重复 / 光标位置'],
    ['Chrome 或 Safari 网页文本框', 'A01 一次', '能插入 / 焦点丢失'],
    ['微信草稿 / 邮件草稿', 'A01 各一次，不发送', '能插入 / 意外发送'],
    ['VS Code 普通文本文件（可选）', 'A05 一次', '术语 / 光标 / 缩进'],
], [192, 148, 167])

# Page 6
page('可选对照与已知边界')
heading('N01  你的真实说话环境', 2)
text('用 A01 和 A05，对照安静环境 / 正常办公背景声；近距离 / 平常坐姿；正常语速 / 自然较快语速。一次只改变一个因素，不用刻意播放很大噪声。两条各重复三次，记录口音、麦克风和大致距离。不要只保留成功的一次。')
heading('L01  其他语言与混说', 2)
text('若你会粤语、日语或韩语，各自然说 1-2 句你能校对的内容，并写下预期含义。不会的语言跳过。SenseVoice 自动检测不代表支持所有语言；只支持上述五种语言，其他语言不作为本轮准确率测试对象。')
heading('C01  长短录音', 2)
text('分别录制很短的一句话、35-45 秒的自然讲话，以及超过 9 分钟的长录音。所有录音都应使用 SenseVoice Small，不能切换其他模型，也不能自动截断。长录音在内部按停顿分段处理，检查句首、分段附近与末尾是否遗漏或重复。')
heading('本轮不作为“已完善”的依据', 2)
text('个人词典虽然有界面，目前尚未完成对识别结果的完整接入；添加词条不应被当作已经提高准确率。可把 A05/A08 的错误留作后续词典样本。')
text('自动更新、Windows/Intel Mac、正式签名、公网账号同步、超长录音分段和全量语言覆盖不属于这个测试包的已完成项。遇到登录或引导阻塞，直接记录阻塞页面；不要为了继续测试而删除历史或修改账户数据。')
heading('严重问题优先反馈', 2)
text('最高优先：录音或历史丢失、取消后仍插入、文字插到错误应用、意外发送草稿、改变金额/数量/否定词。其次：持续卡住、重启后设置丢失、普通短句反复识别失败。偶发标点问题可以集中反馈。')

# Page 7
page('把结果按这个格式发给我')
text('PDF 可打印手写；要复制结果或填写较长文字，请用同目录的 Markdown 版。Markdown 末尾有完整记录表和可重复复制的问题模板。无需填写 API Key，也无需发送私人聊天或整份历史数据库。')
heading('结果汇总', 2)
table(['项目', '填写'], [
    ['版本 / 环境', f'{VERSION}；Mac：______；macOS：______；麦克风：______'],
    ['基础结论', '安装：通过 / 有问题 / 阻塞；日常能否替代：能 / 部分 / 不能'],
    ['热运行典型耗时', 'A：_____ 秒；B：_____ 秒；C（可选）：_____ 秒'],
    ['最影响使用的三个问题', '1. _________________________________\n2. _________________________________\n3. _________________________________'],
], [142, 365])
heading('逐条记录示例与空表', 2)
table(['编号 / 组别 / 次数', '实际输出或现象', '耗时', '结论'], [
    ['示例 A04 / A / 1', '打85折，订单编号712', '0.8秒', '有问题'],
    ['________________', '________________________', '_____', '________'],
    ['________________', '________________________', '_____', '________'],
    ['________________', '________________________', '_____', '________'],
    ['________________', '________________________', '_____', '________'],
], [139, 225, 55, 88])
heading('每个重要问题单独写一条', 2)
for line in [
    '问题编号 / 对应用例：____________________________________________',
    '模式与配置（A/B/C；听写/翻译/指令）：______________________________',
    '我说了什么 / 选中了什么：________________________________________',
    '实际输出 / 错误提示原文：________________________________________',
    '我希望得到什么：________________________________________________',
    '复现次数：___ / ___；耗时：___秒；目标应用：_______________________',
    '恢复方式：重试 / 重录 / 重启 / 无法恢复；附件名称（可选）：___________',
]: text(line, 'small')
text('可选附件：对应的测试录音、展示操作过程的短录屏、截图。请仅提供本清单里的虚构内容或你愿意分享的样本；密钥字段留空或遮住。')

all_ids = [c[0] for c in accuracy] + [c[0] for c in refinement] + [r[0] for r in reliability] + ['X01','N01','L01','C01','D01']
md += ['## 可填写完整记录表\n', '每次重复新增一行。X01 请按应用分别填行。\n',
       '| 用例 | 组别 | 第几次 | 实际输出 / 现象 | 结束到插入（秒） | 结论 | 备注 / 附件 |',
       '| --- | --- | --- | --- | --- | --- | --- |']
for cid in all_ids: md.append(f'| {cid} | | | | | 未测 | |')
md += ['', '## 可复制问题模板\n', '- 问题编号 / 用例：\n- 版本：'+VERSION+'\n- Mac / macOS / 麦克风：\n- 模型 / DeepSeek 开关 / 输入语言 / 翻译目标：\n- 模式 / 目标应用：\n- 朗读原文 / 选区：\n- 实际输出（原样粘贴）：\n- 期望结果：\n- 复现次数： /\n- 结束到插入： 秒\n- 当时网络 / 噪声：\n- 如何恢复：\n- 附件（可选）：\n']

def page_frame(canvas, doc):
    width, height = A4
    canvas.setStrokeColor(LINE); canvas.setLineWidth(.6)
    canvas.line(44, height-39, width-44, height-39)
    canvas.setFont('Chinese', 8); canvas.setFillColor(GRAY)
    canvas.drawString(44, height-29, f'OpenType {VERSION}  /  真人测试')
    canvas.line(44, 37, width-44, 37)
    canvas.drawString(44, 24, '2026-10-07  ·  记录真实结果，保留失败样本')
    canvas.drawRightString(width-44, 24, f'{doc.page} / 7')

pdf_path = OUT / f'OpenType-{VERSION}-真人测试指南.pdf'
doc = SimpleDocTemplate(str(pdf_path), pagesize=A4, leftMargin=44, rightMargin=44, topMargin=54, bottomMargin=51,
                        title=f'OpenType {VERSION} 真人测试指南', author='OpenType', allowSplitting=1)
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
md_path = ROOT / 'docs/testing' / f'OpenType-{VERSION}-真人测试指南.md'
md_path.parent.mkdir(parents=True, exist_ok=True)
md_path.write_text('\n'.join(md), encoding='utf8')
shutil.copy2(pdf_path, DELIVERY / pdf_path.name)
shutil.copy2(md_path, DELIVERY / md_path.name)
print(pdf_path)
print(md_path)
