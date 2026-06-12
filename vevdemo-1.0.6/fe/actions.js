import TTUploader from 'tt-uploader';
import { post, get, getType } from './util';

const VEV_REGION = import.meta.env.VITE_VEV_REGION || 'cn-north-1';
const VOD_HOST = import.meta.env.VITE_VEV_VOD_HOST || 'https://vod.volcengineapi.com';
const VOD_ACCOUNT_ID = import.meta.env.VITE_VEV_VOD_ACCOUNT_ID || '11111';
const UPLOAD_APP_ID = Number(import.meta.env.VITE_VEV_UPLOAD_APP_ID || 0);
const UPLOAD_WORKFLOW_TEMPLATE_ID = String(import.meta.env.VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID || '').trim();

function buildUploadProcessActions({ file, category, fileType, extension }) {
  const actions = [
    {
      Name: 'GetMeta',
    },
    {
      Name: 'AddOptionInfo',
      Input: {
        Title: file.name,
        Category: file?.type?.split('/')?.[0] === 'audio' ? 'audio' : fileType.type,
        FileType: fileType.fileType,
        Format: category === 'audio' && extension === 'mpeg' ? 'mp3' : extension,
        RecordType: category === 'image' || fileType.fileType === 'object' ? 2 : undefined,
        ...(file.ClassificationId ? { ClassificationId: Number(file.ClassificationId) } : {}),
      },
    },
  ];

  if (category === 'video') {
    if (UPLOAD_WORKFLOW_TEMPLATE_ID) {
      actions.push({
        Name: 'StartWorkflow',
        Input: {
          TemplateId: UPLOAD_WORKFLOW_TEMPLATE_ID,
        },
      });
    } else {
      console.warn('[VevDemo] VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID is not configured; uploaded videos may lack H.264/AAC playable renditions.');
    }
  }

  return actions;
}

const initUploader = async (file, space) => {
  let stsToken;
  stsToken = await getUploadToken();
  const accountId = VOD_ACCOUNT_ID; // 这里需要修改为实际的火山视频点播账号ID
  const extension = file?.type?.split('/')?.[1] ?? '';
  const fileType = getType(extension);
  const Category = file?.type?.split('/')?.[0] === 'audio' ? 'audio' : fileType.type;
  const processAction = buildUploadProcessActions({ file, category: Category, fileType, extension });
  const uploadOption = {
    userId: String(accountId), //建议设置能识别用户的唯一标识id，用于上传出错时排查问题，不要传入非 ASCII编码
    appId: UPLOAD_APP_ID, //在应用云平台申请的appid
    stsToken, //从服务端拿到的token
    videoConfig: {
      spaceName: space, //在视频云中申请的点播空间名
      processAction,
    },
    accountId,
  };
  uploadOption.region = VEV_REGION; // 这里需要修改为实际的火山视频点播区域，暂只支持cn-north-1区域
  uploadOption.videoHost = VOD_HOST; // 火山视频点播OpenAPI地址
  const uploader = new TTUploader(uploadOption);
  return uploader;
};


// 获取剪辑项目信息
export const describeProject = async ({ GroupId, ProjectId }) => {
  const projectInfo = await post('/api/describeProject', { GroupId, ProjectId });
  return projectInfo.Result;
}

// 获取剪辑素材
export const searchEditMaterial = async ({ ProjectId, Space, EditMids }) => {
  const materialInfo = await post('/api/searchEditMaterial', { ProjectId, Space, EditMids });
  return materialInfo.Result;
};

// 更新剪辑项目
export const updateProject = async (project) => {
  const res = await post('/api/updateProject', project);
  return res.Result;
};

// 获取资源包列表
export const getEffectList = async (params) => {
  const res = await post('/api/getEffectList', params);
  return res.Result;
};

// 提交剪辑任务
export const submitEditTaskAsync = async (params) => {
  const res = await post('/api/submitEditTaskAsync', params);
  return res.Result;
};

// 删除剪辑素材
export const deleteEditMaterial = async (params) => {
  const res = await post('/api/deleteEditMaterial', params);
  return res.Result;
};

export const createEditMaterial = async (params) => {
  const res = await post('/api/createEditMaterial', params);
  return res.Result;
};

// 更新素材发布状态
export const updateMediaPublishStatus = async (params) => {
  const res = await post('/api/updateMediaPublishStatus', params);
  return res.Result;
};

// 视频搜索
export const searchVideo = async (params) => {
  const res = await get('/api/searchVideo', params);
  return res.Result;
};

// 获取视频播放信息
export const getVideoPlayInfo = async (params) => {
  const res = await get('/api/getVideoPlayInfo', params);
  return {
    ...res.Result?.VideoDetail?.VideoDetailInfo ?? {},
    ...res.Result?.VideoDetail?.VideoDetailInfo?.PlayInfo ?? {},
    PlayUrl: res.Result?.VideoDetail?.VideoDetailInfo?.PlayInfo?.MainPlayUrl,
  };
};

// 获取素材信息
export const mGetMaterial = async (params) => {
  const res = await get('/api/mGetMaterial', params);
  return res.Result;
};

// 获取上传token
export const getUploadToken = async () => {
  const res = await get('/api/getUploadToken');
  return res.Result;
};

// 获取视频分类列表
export const listVideoClassifications = async (params) => {
  const res = await get('/api/listVideoClassifications', params);
  return res.Result;
};

// 上传素材
export const uploadMaterial = async (file, space, region, handler) => {
  const { onComplete, onError, onProgress } = handler;
  const extension = file?.type?.split('/')?.[1] ?? '';
  const uploader = await initUploader(file, space, region);
  uploader.on('complete', (info) => {
    onComplete && onComplete({ file, info, space });
  });
  uploader.on('error', (error) => {
    onError && onError({ file, error });
  });
  uploader.on('progress', (info) => {
    onProgress && onProgress({ file, info });
  });
  const fileKey = uploader.addFile({
    file,
    type: getType(extension)?.fileType, // 上传文件类型，三个可选值：video(视频或者音频，默认值，火山为media)，image(图片)，object（普通文件）
  });
  uploader.start(fileKey);
};
